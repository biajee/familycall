import { STRINGS, applyI18n } from './i18n.js';
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
  btnSettings: $('#btnSettings'),
  settingsPanel: $('#settingsPanel'),
  selProvider: $('#selProvider'),
  selLang: $('#selLang'),
  btnCloseSettings: $('#btnCloseSettings'),
  btnMyStt: $('#btnMyStt'),
  btnPeerStt: $('#btnPeerStt'),
  btnAlerts: $('#btnAlerts'),
  btnAlertsSetup: $('#btnAlertsSetup'),
  alertsHint: $('#alertsHint'),
  incoming: $('#incoming'),
  incomingFrom: $('#incomingFrom'),
  btnAnswer: $('#btnAnswer'),
  btnIgnore: $('#btnIgnore'),
};

const PROVIDER_LABELS = { openai: 'OpenAI', deepgram: 'Deepgram', xfyun: '讯飞', funasr: 'FunASR', mock: 'Mock' };

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
  remoteStream: null,
  swapped: false, // small window tapped: local video in the big window, remote in the small one
  wakeLock: null,
  connectionState: 'new',
  sttOk: null,
  sttOff: false, // my transcription is currently off (by me or by the other side)
  sttProviders: [],
};

const captions = new Captions(ui.captions);
let profile = loadProfile();
saveProfile(); // persist URL-derived identity and any auto-assigned name
let T = STRINGS[profile.ui];
let toastTimer = null;

// Debug / end-to-end test hook.
window.__familycall = { state, profile, captions, roomLink: (...a) => roomLink(...a), showIncoming, hideIncoming };

/* ---------- profile ---------- */

function loadProfile() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}') || {}; } catch { /* ignore */ }
  // The URL defines identity (so a home-screen shortcut is enough to configure a phone);
  // localStorage keeps in-app preferences such as caption size.
  const q = new URLSearchParams(location.search);
  for (const k of ['name', 'room', 'lang', 'ui', 'key', 'stt']) if (q.has(k)) p[k] = q.get(k).trim();
  if (q.has('simple')) p.simple = q.get('simple') === '1';
  if (q.has('font')) p.font = Number(q.get('font'));
  if (!['zh', 'en'].includes(p.ui)) p.ui = 'zh'; // Chinese by default; ?ui=en or the settings switch it
  if (!['zh-CN', 'en-US', 'auto'].includes(p.lang)) p.lang = p.ui === 'zh' ? 'zh-CN' : 'en-US';
  p.font = clamp(Number(p.font) || 30, FONT_MIN, FONT_MAX);
  p.name = (p.name || '').slice(0, 32);
  p.room = (p.room || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);
  // A generic room link carries no name: assign one so the person can join
  // with a single tap (kept in localStorage, so it stays stable).
  if (!p.name) p.name = (p.ui === 'zh' ? '家人' : 'Guest') + Math.floor(100 + Math.random() * 900);
  // Stable per-phone id: keeps a caller from ringing their own phone.
  if (!p.device) p.device = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).replace(/-/g, '').slice(0, 12);
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


function setSttStatus(ok, message, provider) {
  state.sttOk = ok;
  const name = provider || state.stt?.name;
  const label = name === 'off' ? T.sttOff : ((name && PROVIDER_LABELS[name]) || name || '');
  // The dot is the status indicator; the text is just the provider's name
  // (plus the error message when something is wrong). Tap it to open settings.
  ui.sttDot.className = 'dot ' + (ok === null ? '' : ok ? 'ok' : 'bad');
  ui.capLabel.textContent = ok === false
    ? `${label || T.captionsOff}${message ? ' · ' + message : ''}`
    : (label || T.captionsIdle);
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
  startPresence();
  updateAlertsUI();
}

/* ---------- ringing: presence connection + incoming-call overlay ---------- */

let presence = null;
let ringTimer = null;
let ringAudio = null;

// While the app is open on the start screen, stay connected so the server can
// ring us the moment the other person starts a call in our room.
function startPresence() {
  if (presence || !profile.room || state.inCall) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sig = new Signaling(`${proto}://${location.host}/ws`);
  sig.onopen = () => sig.send({ type: 'listen', room: profile.room, key: profile.key || '', device: profile.device });
  sig.onmessage = (msg) => {
    if (msg.type === 'ring') showIncoming(msg.from);
    else if (msg.type === 'ring-cancel') hideIncoming();
  };
  sig.onfail = () => {};
  presence = sig;
  sig.connect();
}

function stopPresence() {
  presence?.close();
  presence = null;
}

function showIncoming(from) {
  ui.incomingFrom.textContent = T.incomingCall(from || '');
  ui.incoming.classList.remove('hidden');
  startRinging();
}

function hideIncoming() {
  ui.incoming.classList.add('hidden');
  stopRinging();
}

// A simple ring tone + vibration pattern. Browsers may keep audio silent until
// the user has interacted with the page; the overlay and vibration still show.
function startRinging() {
  stopRinging();
  try { navigator.vibrate?.([600, 300, 600, 300, 600]); } catch { /* unsupported */ }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ringAudio = new Ctx();
    const beep = () => {
      if (!ringAudio) return;
      const g = ringAudio.createGain();
      g.gain.value = 0.25;
      g.connect(ringAudio.destination);
      for (const [f, t] of [[880, 0], [660, 0.35]]) {
        const o = ringAudio.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        o.connect(g);
        o.start(ringAudio.currentTime + t);
        o.stop(ringAudio.currentTime + t + 0.3);
      }
    };
    beep();
    ringTimer = setInterval(() => { beep(); try { navigator.vibrate?.([600, 300, 600]); } catch { /* ignore */ } }, 2500);
  } catch { /* no audio */ }
}

function stopRinging() {
  clearInterval(ringTimer);
  ringTimer = null;
  try { navigator.vibrate?.(0); } catch { /* ignore */ }
  ringAudio?.close().catch(() => {});
  ringAudio = null;
}

/* ---------- ringing: push notifications ("开启来电提醒") ---------- */

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  && location.protocol === 'https:';

async function currentPushSubscription() {
  if (!pushSupported) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch { return null; }
}

async function updateAlertsUI() {
  const buttons = [ui.btnAlerts, ui.btnAlertsSetup];
  if (!pushSupported || !profile.room) {
    for (const b of buttons) b.classList.add('hidden');
    // iOS only allows push for apps launched from the Home Screen.
    ui.alertsHint.textContent = T.alertsIosHint;
    ui.alertsHint.classList.toggle('hidden', !(isIOS && !isStandalone && profile.room));
    return;
  }
  ui.alertsHint.classList.add('hidden');
  const sub = await currentPushSubscription();
  const on = !!sub && Notification.permission === 'granted';
  for (const b of buttons) {
    b.textContent = on ? T.alertsOn : T.alertsEnable;
    b.classList.toggle('on', on);
    b.classList.remove('hidden');
  }
}

function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enableCallAlerts() {
  try {
    const cfg = await fetch('push/config', { cache: 'no-store' }).then((r) => r.json());
    if (!cfg.enabled) { toast(T.alertsFailed); return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast(T.alertsDenied, 6000); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription()
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(cfg.publicKey) });
    const res = await fetch('push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: profile.room, key: profile.key || '', name: profile.name, device: profile.device, subscription: sub }),
    });
    if (!res.ok) throw new Error(`subscribe ${res.status}`);
    toast(T.alertsOn);
  } catch (err) {
    console.warn('call alerts failed', err);
    toast(T.alertsFailed, 6000);
  }
  updateAlertsUI();
}

/* ---------- media ---------- */

async function getMedia() {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  // 720p (phones deliver it portrait-oriented) instead of 640x480: the big
  // window fills a portrait screen, so a small landscape frame gets upscaled
  // and looks soft. WebRTC still scales down when the link cannot carry it.
  const video = {
    facingMode: state.facing,
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 24, max: 30 },
  };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio, video });
    for (const t of stream.getVideoTracks()) t.contentHint = 'detail';
    return stream;
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

/* ---------- video windows: swap on tap, drag the small one ---------- */

// Both <video> elements are fixed in the layout (big / small); which stream
// each shows depends on state.swapped. The element showing the local camera
// stays muted (no echo) and mirrored when the front camera is used.
function applyVideoLayout() {
  const localEl = state.swapped ? ui.remoteVideo : ui.localVideo;
  const remoteEl = state.swapped ? ui.localVideo : ui.remoteVideo;
  if (localEl.srcObject !== state.localStream) localEl.srcObject = state.localStream;
  if (remoteEl.srcObject !== state.remoteStream) remoteEl.srcObject = state.remoteStream;
  localEl.muted = true;
  remoteEl.muted = false;
  localEl.classList.toggle('mirror', state.facing === 'user');
  remoteEl.classList.remove('mirror');
  if (state.remoteStream) remoteEl.play().catch(() => toast(T.tapToPlay, 6000));
  if (state.localStream) localEl.play().catch(() => {});
}

function swapVideos() {
  state.swapped = !state.swapped;
  applyVideoLayout();
}

// Drag the small window anywhere over the video; a tap (no movement) swaps.
function makeDraggable(el, area, onTap) {
  let id = null;
  let sx = 0; let sy = 0; let ox = 0; let oy = 0; let moved = false;
  el.addEventListener('pointerdown', (e) => {
    id = e.pointerId;
    sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect();
    const a = area.getBoundingClientRect();
    ox = r.left - a.left; oy = r.top - a.top;
    moved = false;
    el.setPointerCapture?.(id);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (id === null || e.pointerId !== id) return;
    const dx = e.clientX - sx; const dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) < 6) return;
    moved = true;
    const a = area.getBoundingClientRect();
    const x = Math.max(0, Math.min(a.width - el.offsetWidth, ox + dx));
    const y = Math.max(0, Math.min(a.height - el.offsetHeight, oy + dy));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.right = 'auto';
  });
  const end = (e) => {
    if (id === null || e.pointerId !== id) return;
    id = null;
    if (!moved) onTap();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => { id = null; });
}
makeDraggable(ui.localVideo, $('#videos'), swapVideos);

/* ---------- call lifecycle ---------- */

async function joinCall() {
  if (state.inCall) return;
  state.inCall = true;
  hideIncoming();
  stopPresence();
  // The AudioContext must be created inside the tap handler on iOS.
  state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  captions.clear();
  setSttStatus(null);
  state.remoteStream = null;
  applyVideoLayout();
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
  applyVideoLayout();
  setStatus(T.connecting);
  requestWakeLock();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sig = new Signaling(`${proto}://${location.host}/ws`);
  sig.onopen = () => {
    sig.send({
      type: 'join', room: profile.room, name: profile.name, lang: profile.lang,
      key: profile.key || '', stt: profile.stt || '', device: profile.device,
    });
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
      state.sttProviders = msg.sttProviders || [];
      captions.setSelf(msg.id);
      applySttInfo(msg.stt);
      if (msg.stt.autoLang === false && profile.lang === 'auto') toast(T.noAutoLang, 6000);
      if (msg.peers && msg.peers[0]) onPeerJoined(msg.peers[0], msg.polite);
      else setStatus(T.waitingPeer);
      break;
    case 'peer-joined':
      onPeerJoined(msg.peer, msg.polite);
      break;
    case 'peer-updated':
      if (state.peer && msg.peer.id === state.peer.id) state.peer = msg.peer;
      updateSttButtons();
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
      setSttStatus(!!msg.ok, msg.ok ? '' : msg.message, msg.provider);
      break;
    case 'stt-info':
      // Provider switched server-side (or captions turned off): re-capture as needed.
      applySttInfo(msg.stt);
      if (msg.by === 'peer') toast(msg.stt.name === 'off' ? T.captionsOffByPeer : T.captionsOnByPeer, 5000);
      break;
    case 'error':
      console.warn('server error', msg);
      toast(T[msg.code] || msg.message || msg.code, 6000);
      // room_unavailable/not_found come from the optional FamilyCall shell's room
      // check (server/familycall.js) — same "give up and go back to setup"
      // treatment as a bad room/key, not just a toast left hanging on the call
      // screen. caption_limit is deliberately NOT here: the call carries on.
      if (['room_full', 'bad_key', 'bad_room', 'room_unavailable', 'not_found'].includes(msg.code)) leaveCall();
      break;
    default:
      break;
  }
}

function onPeerJoined(peer, polite) {
  state.peer = peer;
  state.polite = polite;
  updateSttButtons();
  teardownPeer();
  setStatus(T.connecting);
  state.call = new Call({
    polite,
    iceServers: state.iceServers,
    localStream: state.localStream,
    sendSignal: (data) => state.signaling.send({ type: 'signal', to: peer.id, data }),
    onRemoteStream: (stream) => {
      if (state.remoteStream !== stream) {
        state.remoteStream = stream;
        applyVideoLayout();
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
  updateSttButtons();
  setStatus(`${T.peerLeft} · ${T.waitingPeer}`);
}

function teardownPeer() {
  if (state.call) {
    state.call.close();
    state.call = null;
  }
  state.connectionState = 'new';
  state.remoteStream = null;
  applyVideoLayout();
}

function updateSttButtons() {
  ui.btnMyStt.classList.toggle('active', state.sttOff);
  ui.btnMyStt.textContent = state.sttOff ? '💬' : '💬';
  const peerOff = !!state.peer && state.peer.captions === false;
  ui.btnPeerStt.disabled = !state.peer;
  ui.btnPeerStt.classList.toggle('active', peerOff);
}

function applySttInfo(info) {
  state.stt = info;
  state.sttOff = info.name === 'off';
  updateSttButtons();
  if (info.name === 'off') {
    stopCapture(); // nothing is sent to any transcription service
    setSttStatus(null, '', 'off');
  } else {
    setSttStatus(null);
    startCapture(info.audioRate);
  }
}

function stopCapture() {
  if (!state.capture) return;
  state.capture.stop();
  state.capture = null;
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
  state.remoteStream = null;
  state.swapped = false;
  applyVideoLayout();
  state.audioCtx?.close().catch(() => {});
  state.audioCtx = null;
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
  state.muted = false;
  state.camOff = false;
  ui.btnMute.classList.remove('active');
  ui.btnCam.classList.remove('active');
  ui.settingsPanel.classList.add('hidden');
  setStatus('');
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
captions.onCopy = (text) => copyLink(text, T.capCopied); // tap a caption bubble to copy it

ui.quickJoin.addEventListener('click', () => joinCall());
ui.btnAlerts.addEventListener('click', enableCallAlerts);
ui.btnAlertsSetup.addEventListener('click', enableCallAlerts);
ui.btnAnswer.addEventListener('click', () => joinCall());
ui.btnIgnore.addEventListener('click', hideIncoming);
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
      video: { facingMode: { exact: state.facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
    });
    const track = s.getVideoTracks()[0];
    track.enabled = !state.camOff;
    state.localStream.removeTrack(old);
    old.stop();
    state.localStream.addTrack(track);
    const localEl = state.swapped ? ui.remoteVideo : ui.localVideo;
    localEl.srcObject = null; // re-attach so the element picks up the new track
    applyVideoLayout();
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

// 💬 my transcription on/off (remembered like the settings picker);
// 🗨️ the other phone's transcription on/off, applied by the server.
ui.btnMyStt.addEventListener('click', () => {
  if (state.sttOff) {
    if (profile.stt === 'off') profile.stt = profile.sttPrev || '';
  } else {
    profile.sttPrev = profile.stt;
    profile.stt = 'off';
  }
  saveProfile();
  state.signaling?.send({ type: 'update', stt: profile.stt });
  toast(state.sttOff ? T.myCaptionsOn : T.myCaptionsOff);
});
ui.btnPeerStt.addEventListener('click', () => {
  if (!state.peer) return;
  const off = state.peer.captions !== false; // currently on -> turn off
  state.signaling?.send({ type: 'peer-stt', off });
  toast(off ? T.peerCaptionsOff : T.peerCaptionsOn);
});
ui.btnFontDown.addEventListener('click', () => changeFont(-4));

ui.btnHangup.addEventListener('click', () => {
  if (window.confirm(T.hangupConfirm)) leaveCall();
});

/* ---------- in-call settings ---------- */

function openSettings() {
  ui.selProvider.textContent = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = T.sttDefault;
  ui.selProvider.append(def);
  for (const p of state.sttProviders) {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = PROVIDER_LABELS[p] || p;
    ui.selProvider.append(o);
  }
  const off = document.createElement('option');
  off.value = 'off';
  off.textContent = T.sttOff;
  ui.selProvider.append(off);
  ui.selProvider.value = profile.stt === 'off' || state.sttProviders.includes(profile.stt) ? profile.stt : '';
  ui.selLang.value = profile.lang;
  ui.settingsPanel.classList.remove('hidden');
}

ui.btnSettings.addEventListener('click', () => {
  if (ui.settingsPanel.classList.contains('hidden')) openSettings();
  else ui.settingsPanel.classList.add('hidden');
});
ui.btnCloseSettings.addEventListener('click', () => ui.settingsPanel.classList.add('hidden'));
$('#capBar').addEventListener('click', () => { if (state.inCall) openSettings(); });

ui.selProvider.addEventListener('change', () => {
  profile.stt = ui.selProvider.value;
  saveProfile();
  state.signaling?.send({ type: 'update', stt: profile.stt });
});

ui.selLang.addEventListener('change', () => {
  profile.lang = ui.selLang.value;
  saveProfile();
  state.signaling?.send({ type: 'update', lang: profile.lang });
  if (profile.lang === 'auto' && state.stt?.autoLang === false) toast(T.noAutoLang, 6000);
});

// Tapping the video area retries playback (browsers may block un-gestured audio playback).
ui.remoteVideo.addEventListener('click', () => {
  ui.remoteVideo.play().catch(() => {});
  ui.localVideo.play().catch(() => {});
});

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
  navigator.serviceWorker.register('sw.js').then(() => updateAlertsUI()).catch(() => {});
}
// Opened from a "xx 来电" notification: show the answer screen right away
// (the presence connection cancels it if the caller already hung up).
{
  const q = new URLSearchParams(location.search);
  if (q.get('ring') === '1' && profile.room) showIncoming(q.get('from') || '');
}
