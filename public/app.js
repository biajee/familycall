import { STRINGS, applyI18n, detectUiLang } from './i18n.js';
import { Signaling } from './signaling.js';
import { Call } from './peer.js';
import { MicCapture } from './capture.js';
import { Captions } from './captions.js';

const PROFILE_KEY = 'familycall.profile.v1';
const FONT_MIN = 20;
const FONT_MAX = 64;
const $ = (s) => document.querySelector(s);

const ui = {
  setup: $('#setup'),
  quick: $('#quick'),
  call: $('#call'),
  form: $('#setupForm'),
  quickJoin: $('#quickJoin'),
  quickSettings: $('#quickSettings'),
  quickInfo: $('#quickInfo'),
  remoteVideo: $('#remoteVideo'),
  localVideo: $('#localVideo'),
  status: $('#callStatus'),
  captions: $('#captions'),
  sttDot: $('#sttDot'),
  capLabel: $('#capLabel'),
  toast: $('#toast'),
  btnMute: $('#btnMute'),
  btnCam: $('#btnCam'),
  btnFlip: $('#btnFlip'),
  btnFontUp: $('#btnFontUp'),
  btnFontDown: $('#btnFontDown'),
  btnHangup: $('#btnHangup'),
  btnInvite: $('#btnInvite'),
  btnInviteCall: $('#btnInviteCall'),
};

const state = {
  inCall: false,
  signaling: null,
  call: null,
  capture: null,
  audioCtx: null,
  localStream: null,
  me: null,
  polite: false,
  iceServers: [],
  stt: null,
  peer: null,
  muted: false,
  camOff: false,
  facing: 'user',
  wakeLock: null,
  connectionState: 'new',
  sttOk: null,
};

const captions = new Captions(ui.captions);
let profile = loadProfile();
saveProfile(); // persist URL-derived identity and any auto-assigned name
let T = STRINGS[profile.ui];
let toastTimer = null;

// Debug / end-to-end test hook.
window.__familycall = { state, profile, captions, roomLink: (...a) => roomLink(...a) };

/* ---------- profile ---------- */

function loadProfile() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}') || {}; } catch { /* ignore */ }
  // The URL defines identity (so a home-screen shortcut is enough to configure a phone);
  // localStorage keeps in-app preferences such as caption size.
  const q = new URLSearchParams(location.search);
  for (const k of ['name', 'room', 'lang', 'ui', 'key']) if (q.has(k)) p[k] = q.get(k).trim();
  if (q.has('simple')) p.simple = q.get('simple') === '1';
  if (q.has('font')) p.font = Number(q.get('font'));
  if (!['zh', 'en'].includes(p.ui)) p.ui = detectUiLang();
  if (!['zh-CN', 'en-US', 'auto'].includes(p.lang)) p.lang = p.ui === 'zh' ? 'zh-CN' : 'en-US';
  p.font = clamp(Number(p.font) || 30, FONT_MIN, FONT_MAX);
  p.name = (p.name || '').slice(0, 32);
  p.room = (p.room || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);
  // A generic room link carries no name: assign one so the person can join
  // with a single tap (kept in localStorage, so it stays stable).
  if (!p.name) p.name = (p.ui === 'zh' ? '家人' : 'Guest') + Math.floor(100 + Math.random() * 900);
  return p;
}

function saveProfile() {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch { /* private mode */ }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/* ---------- UI helpers ---------- */

function show(screen) {
  for (const s of [ui.setup, ui.quick, ui.call]) s.classList.toggle('hidden', s !== screen);
}

function toast(msg, ms = 3500) {
  ui.toast.textContent = msg;
  ui.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.add('hidden'), ms);
}

function setStatus(text) {
  ui.status.textContent = text || '';
  ui.status.classList.toggle('hidden', !text);
}

// While waiting alone in the room, offer the invite link right on the call
// screen (hidden in simple mode to keep Dad's screen minimal).
function updateInviteCallBtn() {
  const waiting = state.inCall && !state.peer && !profile.simple;
  ui.btnInviteCall.classList.toggle('hidden', !waiting);
}

function setSttStatus(ok, message) {
  state.sttOk = ok;
  ui.sttDot.className = 'dot ' + (ok === null ? '' : ok ? 'ok' : 'bad');
  ui.capLabel.textContent = ok === null ? T.captionsIdle : ok ? T.captionsOn : `${T.captionsOff}${message ? ' · ' + message : ''}`;
}

function applyFont() {
  document.documentElement.style.setProperty('--cap-size', profile.font + 'px');
}

function fillForm() {
  const f = ui.form;
  f.name.value = profile.name || '';
  f.room.value = profile.room || '';
  f.lang.value = profile.lang;
  f.ui.value = profile.ui;
  f.simple.checked = !!profile.simple;
}

function setManifestLink() {
  const link = document.querySelector('link[rel="manifest"]');
  if (link) link.href = 'manifest.webmanifest' + location.search;
}

function idleScreen() {
  if (profile.simple && profile.room && profile.name) {
    ui.quickInfo.textContent = T.quickInfo(profile);
    show(ui.quick);
  } else {
    fillForm();
    show(ui.setup);
  }
}

/* ---------- media ---------- */

async function getMedia() {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const video = {
    facingMode: state.facing,
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 20, max: 24 },
  };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video });
  } catch (err) {
    console.warn('video capture failed, falling back to audio only:', err);
    toast(T.mediaAudioOnly);
    return navigator.mediaDevices.getUserMedia({ audio });
  }
}

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* not supported or denied */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.inCall && !state.wakeLock) requestWakeLock();
});

/* ---------- call lifecycle ---------- */

async function joinCall() {
  if (state.inCall) return;
  state.inCall = true;
  // The AudioContext must be created inside the tap handler on iOS.
  state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  captions.clear();
  setSttStatus(null);
  ui.remoteVideo.srcObject = null;
  show(ui.call);
  setStatus(T.gettingMedia);

  try {
    state.localStream = await getMedia();
  } catch (err) {
    console.error(err);
    toast(T.mediaError, 7000);
    leaveCall();
    return;
  }
  ui.localVideo.srcObject = state.localStream;
  ui.localVideo.classList.toggle('rear', state.facing === 'environment');
  setStatus(T.connecting);
  requestWakeLock();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sig = new Signaling(`${proto}://${location.host}/ws`);
  sig.onopen = () => {
    sig.send({ type: 'join', room: profile.room, name: profile.name, lang: profile.lang, key: profile.key || '' });
  };
  sig.onclose = () => {
    if (!state.inCall) return;
    setStatus(T.reconnecting);
    teardownPeer();
  };
  sig.onfail = () => toast(T.wsError, 8000);
  sig.onmessage = handleMessage;
  state.signaling = sig;
  sig.connect();
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      state.me = msg.id;
      state.polite = msg.polite;
      state.iceServers = msg.iceServers || [];
      state.stt = msg.stt;
      captions.setSelf(msg.id);
      startCapture(msg.stt.audioRate);
      if (msg.stt.autoLang === false && profile.lang === 'auto') toast(T.noAutoLang, 6000);
      if (msg.peers && msg.peers[0]) onPeerJoined(msg.peers[0], msg.polite);
      else setStatus(T.waitingPeer);
      updateInviteCallBtn();
      break;
    case 'peer-joined':
      onPeerJoined(msg.peer, msg.polite);
      break;
    case 'peer-updated':
      if (state.peer && msg.peer.id === state.peer.id) state.peer = msg.peer;
      break;
    case 'peer-left':
      if (state.peer && msg.id === state.peer.id) onPeerLeft();
      break;
    case 'signal':
      if (state.call && state.peer && msg.from === state.peer.id) state.call.handleSignal(msg.data);
      break;
    case 'caption':
      captions.update(msg);
      break;
    case 'stt-status':
      setSttStatus(!!msg.ok, msg.ok ? '' : msg.message);
      break;
    case 'error':
      console.warn('server error', msg);
      toast(T[msg.code] || msg.message || msg.code, 6000);
      if (['room_full', 'bad_key', 'bad_room'].includes(msg.code)) leaveCall();
      break;
    default:
      break;
  }
}

function onPeerJoined(peer, polite) {
  state.peer = peer;
  state.polite = polite;
  updateInviteCallBtn();
  teardownPeer();
  setStatus(T.connecting);
  state.call = new Call({
    polite,
    iceServers: state.iceServers,
    localStream: state.localStream,
    sendSignal: (data) => state.signaling.send({ type: 'signal', to: peer.id, data }),
    onRemoteStream: (stream) => {
      if (ui.remoteVideo.srcObject !== stream) {
        ui.remoteVideo.srcObject = stream;
        ui.remoteVideo.play().catch(() => toast(T.tapToPlay, 6000));
      }
    },
    onConnectionState: (s) => {
      state.connectionState = s;
      if (s === 'connected') setStatus('');
      else if (s === 'disconnected') setStatus(T.reconnecting);
      else if (s === 'failed') {
        // Full re-join: the server tells the other side to rebuild its connection too.
        setStatus(T.reconnecting);
        state.signaling.reconnect();
      }
    },
  });
}

function onPeerLeft() {
  teardownPeer();
  state.peer = null;
  setStatus(`${T.peerLeft} · ${T.waitingPeer}`);
  updateInviteCallBtn();
}

function teardownPeer() {
  if (state.call) {
    state.call.close();
    state.call = null;
  }
  state.connectionState = 'new';
  ui.remoteVideo.srcObject = null;
}

async function startCapture(rate) {
  if (state.capture) {
    if (state.capture.targetRate === rate) return;
    state.capture.stop();
    state.capture = null;
  }
  try {
    const capture = new MicCapture(state.audioCtx, state.localStream, rate, (buf) => {
      if (!state.muted && state.signaling) state.signaling.sendBinary(buf);
    });
    await capture.start();
    state.capture = capture;
  } catch (err) {
    console.error('microphone capture for captions failed', err);
    setSttStatus(false, err.message);
  }
}

function leaveCall() {
  state.inCall = false;
  if (state.signaling) {
    state.signaling.send({ type: 'leave' });
    state.signaling.close();
    state.signaling = null;
  }
  teardownPeer();
  state.peer = null;
  if (state.capture) {
    state.capture.stop();
    state.capture = null;
  }
  for (const t of state.localStream?.getTracks() || []) t.stop();
  state.localStream = null;
  ui.localVideo.srcObject = null;
  state.audioCtx?.close().catch(() => {});
  state.audioCtx = null;
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
  state.muted = false;
  state.camOff = false;
  ui.btnMute.classList.remove('active');
  ui.btnCam.classList.remove('active');
  setStatus('');
  updateInviteCallBtn();
  idleScreen();
}

/* ---------- controls ---------- */

ui.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(ui.form);
  profile.name = String(fd.get('name') || '').trim().slice(0, 32);
  profile.room = String(fd.get('room') || '').trim().toLowerCase();
  profile.lang = String(fd.get('lang'));
  profile.ui = String(fd.get('ui'));
  profile.simple = fd.get('simple') === 'on';
  saveProfile();
  T = applyI18n(profile.ui);
  joinCall();
});

// Values as currently on screen: the live form when the setup screen is open,
// the saved profile otherwise (the hidden form's selects would report defaults).
function currentConfig() {
  if (ui.setup.classList.contains('hidden')) return profile;
  const fd = new FormData(ui.form);
  return {
    ...profile,
    name: String(fd.get('name') || '').trim().slice(0, 32),
    room: String(fd.get('room') || '').trim().toLowerCase(),
    lang: String(fd.get('lang')),
    ui: String(fd.get('ui')),
    simple: fd.get('simple') === 'on',
  };
}

// Generic invite: anyone opening it joins this room. No name in the link —
// the app assigns one automatically — and simple mode gives one-tap joining;
// UI and spoken language fall back to the phone's own language.
function roomLink() {
  const room = currentConfig().room;
  if (!room) return null;
  const p = new URLSearchParams({ room, simple: '1' });
  if (profile.key) p.set('key', profile.key);
  return `${location.origin}/?${p.toString()}`;
}

async function copyLink(url, copiedMsg) {
  if (!url) { toast(T.inviteNeedRoom); return; }
  let ok = false;
  try {
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch {
    const ta = document.createElement('textarea'); // older vendor browsers
    ta.value = url;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  if (ok) toast(copiedMsg, 6000);
  else window.prompt(T.inviteManual, url);
}
ui.btnInvite.addEventListener('click', () => copyLink(roomLink(), T.inviteCopied));
ui.btnInviteCall.addEventListener('click', () => copyLink(roomLink(), T.inviteCopied));

ui.quickJoin.addEventListener('click', () => joinCall());
ui.quickSettings.addEventListener('click', () => {
  fillForm();
  show(ui.setup);
});

ui.btnMute.addEventListener('click', () => {
  state.muted = !state.muted;
  for (const t of state.localStream?.getAudioTracks() || []) t.enabled = !state.muted;
  ui.btnMute.classList.toggle('active', state.muted);
  ui.btnMute.textContent = state.muted ? '🔇' : '🎤';
});

ui.btnCam.addEventListener('click', () => {
  state.camOff = !state.camOff;
  for (const t of state.localStream?.getVideoTracks() || []) t.enabled = !state.camOff;
  ui.btnCam.classList.toggle('active', state.camOff);
});

ui.btnFlip.addEventListener('click', async () => {
  if (!state.localStream) return;
  const old = state.localStream.getVideoTracks()[0];
  if (!old) return;
  state.facing = state.facing === 'user' ? 'environment' : 'user';
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { exact: state.facing }, width: { ideal: 640 }, height: { ideal: 480 } },
    });
    const track = s.getVideoTracks()[0];
    track.enabled = !state.camOff;
    state.localStream.removeTrack(old);
    old.stop();
    state.localStream.addTrack(track);
    ui.localVideo.srcObject = state.localStream;
    ui.localVideo.classList.toggle('rear', state.facing === 'environment');
    await state.call?.replaceVideoTrack(track);
  } catch (err) {
    console.warn('camera switch failed', err);
    state.facing = state.facing === 'user' ? 'environment' : 'user';
  }
});

function changeFont(delta) {
  profile.font = clamp(profile.font + delta, FONT_MIN, FONT_MAX);
  saveProfile();
  applyFont();
}
ui.btnFontUp.addEventListener('click', () => changeFont(4));
ui.btnFontDown.addEventListener('click', () => changeFont(-4));

ui.btnHangup.addEventListener('click', () => {
  if (window.confirm(T.hangupConfirm)) leaveCall();
});

// Tapping the video area retries playback (browsers may block un-gestured audio playback).
ui.remoteVideo.addEventListener('click', () => ui.remoteVideo.play().catch(() => {}));

window.addEventListener('pagehide', () => {
  state.signaling?.send({ type: 'leave' });
});

/* ---------- boot ---------- */

setManifestLink();
T = applyI18n(profile.ui);
applyFont();
setSttStatus(null);
idleScreen();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
