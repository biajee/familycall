/**
 * End-to-end test: two headless Chrome "phones" (separate browser contexts, fake camera + mic)
 * join the same room, establish a WebRTC call, exchange captions via the mock transcriber,
 * hang up and re-join. Needs puppeteer, a devDependency of this project (npm install).
 */
import puppeteer from 'puppeteer';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const artifacts = resolve(here, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const app = createApp(loadConfig({ PORT: '0', HOST: '127.0.0.1', STT_PROVIDER: 'mock', LOG_LEVEL: 'warn' }));
const addr = await app.listen();
const base = `http://127.0.0.1:${addr.port}`;

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const problems = [];
const fail = (msg) => {
  console.error('E2E FAIL:', msg);
  problems.push(msg);
};

async function openPhone(label, name, lang, ui) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type())) console.log(`[${label}] console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => fail(`[${label}] pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${base}/?room=e2e-room&name=${encodeURIComponent(name)}&lang=${lang}&ui=${ui}&simple=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#quickJoin', { visible: true });
  await page.click('#quickJoin');
  return page;
}

const capsOf = (page) => page.evaluate(() => [...document.querySelectorAll('#captions .cap')].map((c) =>
  `${c.classList.contains('cap-self') ? 'self' : 'peer'}${c.classList.contains('interim') ? '(interim)' : ''} ${c.querySelector('.txt').textContent}`));

const waitConnected = (page, label) => page
  .waitForFunction(() => window.__familycall.state.connectionState === 'connected', { timeout: 20000 })
  .then(() => console.log(`${label}: RTCPeerConnection connected`));

let a;
let b;
try {
  a = await openPhone("A", "Alice", "en-US", "en");
  b = await openPhone("B", "爸爸", "zh-CN", "zh");

  await Promise.all([waitConnected(a, 'A'), waitConnected(b, 'B')]);

  await a.waitForFunction(() => {
    const v = document.getElementById('remoteVideo');
    return v.videoWidth > 0 && v.readyState >= 2;
  }, { timeout: 15000 });
  const dims = await a.evaluate(() => {
    const v = document.getElementById('remoteVideo');
    return `${v.videoWidth}x${v.videoHeight}`;
  });
  console.log(`A: receiving remote video ${dims}`);

  await b.waitForFunction(
    () => [...document.querySelectorAll('#captions .cap-peer .txt')].some((e) => /test caption \d+\./.test(e.textContent)),
    { timeout: 20000 },
  );
  await a.waitForFunction(
    () => [...document.querySelectorAll('#captions .cap-peer .txt')].some((e) => /测试字幕 \d+。/.test(e.textContent)),
    { timeout: 20000 },
  );
  console.log('B captions:', await capsOf(b));
  console.log('A captions:', await capsOf(a));

  // Direction is conveyed by alignment: incoming bubbles left, own bubbles right,
  // each with a wide margin on the side facing the center.
  const aligns = await b.evaluate(() => ({
    peer: getComputedStyle(document.querySelector('#captions .cap-peer')).alignSelf,
    self: getComputedStyle(document.querySelector('#captions .cap-self')).alignSelf,
    peerGap: parseFloat(getComputedStyle(document.querySelector('#captions .cap-peer')).marginRight),
    selfGap: parseFloat(getComputedStyle(document.querySelector('#captions .cap-self')).marginLeft),
  }));
  if (aligns.peer !== 'flex-start') fail(`B incoming captions should align left, got "${aligns.peer}"`);
  if (aligns.self !== 'flex-end') fail(`B own captions should align right, got "${aligns.self}"`);
  if (!(aligns.peerGap > 20)) fail(`peer bubble should keep a right margin, got ${aligns.peerGap}px`);
  if (!(aligns.selfGap > 20)) fail(`self bubble should keep a left margin, got ${aligns.selfGap}px`);
  const colors = await b.evaluate(() => ({
    peer: getComputedStyle(document.querySelector('#captions .cap-peer .txt')).color,
    self: getComputedStyle(document.querySelector('#captions .cap-self .txt')).color,
  }));
  if (colors.peer !== 'rgb(255, 213, 79)') fail(`incoming text should be yellow, got ${colors.peer}`);
  if (colors.self !== 'rgb(255, 255, 255)') fail(`own text should be white, got ${colors.self}`);

  // Tap a bubble -> the copy handler receives its text.
  await b.evaluate(() => {
    window.__copiedText = null;
    window.__familycall.captions.onCopy = (t) => { window.__copiedText = t; };
  });
  const bubble = await b.$('#captions .cap-peer');
  await bubble.click();
  const copied = await b.evaluate(() => window.__copiedText);
  if (!copied || !/test caption/.test(copied)) fail(`tap-to-copy got "${copied}"`);
  console.log(`B: tap copied "${copied}"`);

  // Drag a left bubble toward the center -> delete button appears; clicking it removes the bubble.
  await b.evaluate((el) => { el.dataset.testMark = '1'; }, bubble);
  const box = await bubble.boundingBox();
  await b.mouse.move(box.x + 10, box.y + box.height / 2);
  await b.mouse.down();
  for (let i = 1; i <= 6; i++) await b.mouse.move(box.x + 10 + i * 12, box.y + box.height / 2);
  await b.mouse.up();
  await b.waitForFunction(() => !!document.querySelector('#captions .cap[data-test-mark] .del'), { timeout: 3000 });
  await b.click('#captions .cap[data-test-mark] .del');
  await b.waitForFunction(() => !document.querySelector('#captions .cap[data-test-mark]'), { timeout: 3000 });
  console.log('B: swipe revealed delete, bubble removed');

  for (const [label, page] of [['A', a], ['B', b]]) {
    const ok = await page.evaluate(() => window.__familycall.state.sttOk);
    if (ok !== true) fail(`${label}: STT status is ${ok}`);
  }

  const invite = await a.evaluate(() => window.__familycall.roomLink());
  if (!invite || !invite.includes('room=e2e-room') || !invite.includes('simple=1') || invite.includes('name=')) {
    fail(`room link should carry room+simple and no name: ${invite}`);
  }
  console.log('A room link:', invite);

  // Small video window: tap swaps the two videos, drag moves it, and it comes back on the second tap.
  const smallBox = await (await a.$('#localVideo')).boundingBox();
  await a.click('#localVideo');
  const swapped = await a.evaluate(() => {
    const s = window.__familycall.state;
    return s.swapped && document.getElementById('remoteVideo').srcObject === s.localStream
      && document.getElementById('localVideo').srcObject === s.remoteStream
      && document.getElementById('remoteVideo').muted === true && document.getElementById('localVideo').muted === false;
  });
  if (!swapped) fail('tapping the small window should swap the videos');
  await a.mouse.move(smallBox.x + smallBox.width / 2, smallBox.y + smallBox.height / 2);
  await a.mouse.down();
  for (let i = 1; i <= 8; i++) await a.mouse.move(smallBox.x + smallBox.width / 2 - i * 20, smallBox.y + smallBox.height / 2 + i * 30);
  await a.mouse.up();
  const dragged = await (await a.$('#localVideo')).boundingBox();
  if (!(dragged.x < smallBox.x - 100 && dragged.y > smallBox.y + 150)) fail(`small window did not move: ${JSON.stringify({ smallBox, dragged })}`);
  const stillSwapped = await a.evaluate(() => window.__familycall.state.swapped);
  if (!stillSwapped) fail('a drag must not count as a tap');
  await a.click('#localVideo');
  const restored = await a.evaluate(() => !window.__familycall.state.swapped && document.getElementById('remoteVideo').srcObject === window.__familycall.state.remoteStream);
  if (!restored) fail('second tap should swap the videos back');
  console.log(`A: small window swap + drag OK (moved to ${Math.round(dragged.x)},${Math.round(dragged.y)})`);
  await a.screenshot({ path: `${artifacts}/phone-a-pip.png` });

  const before = await b.evaluate(() => getComputedStyle(document.getElementById('captions')).fontSize);
  await b.click('#btnFontUp');
  const after = await b.evaluate(() => getComputedStyle(document.getElementById('captions')).fontSize);
  console.log(`B caption font: ${before} -> ${after}`);
  if (parseFloat(after) <= parseFloat(before)) fail('A+ did not enlarge captions');

  await a.click('#btnMute');
  const muted = await a.evaluate(() => window.__familycall.state.localStream.getAudioTracks()[0].enabled === false);
  if (!muted) fail('mute did not disable the audio track');
  await a.click('#btnMute');

  // 💬 / 🗨️: toggle my own transcription, and the other phone's, from the controls bar.
  await a.click('#btnPeerStt');
  await b.waitForFunction(() => window.__familycall.state.stt?.name === 'off' && window.__familycall.state.capture === null, { timeout: 5000 });
  await a.waitForFunction(() => document.getElementById('btnPeerStt').classList.contains('active'), { timeout: 5000 });
  await a.click('#btnPeerStt');
  await b.waitForFunction(() => window.__familycall.state.stt?.name === 'mock' && window.__familycall.state.capture !== null, { timeout: 5000 });
  await a.click('#btnMyStt');
  await a.waitForFunction(() => window.__familycall.state.sttOff && window.__familycall.state.capture === null, { timeout: 5000 });
  await b.waitForFunction(() => window.__familycall.state.peer?.captions === false, { timeout: 5000 });
  await a.click('#btnMyStt');
  await a.waitForFunction(() => !window.__familycall.state.sttOff && window.__familycall.state.capture !== null, { timeout: 5000 });
  console.log('A: caption toggles for self and for the other side work');

  // In-call settings: provider picker lists the server's providers; switching re-captures.
  await a.click('#btnSettings');
  await a.waitForSelector('#settingsPanel', { visible: true });
  const provOptions = await a.evaluate(() => [...document.querySelectorAll('#selProvider option')].map((o) => o.value));
  if (!provOptions.includes('') || !provOptions.includes('mock')) fail(`provider options wrong: ${provOptions}`);
  await a.select('#selProvider', 'mock');
  await a.waitForFunction(() => window.__familycall.state.stt?.name === 'mock', { timeout: 5000 });
  await a.select('#selLang', 'zh-CN');
  await b.waitForFunction(() => window.__familycall.state.peer?.lang === 'zh-CN', { timeout: 5000 });
  console.log('A: settings panel switched provider and language');
  await a.screenshot({ path: `${artifacts}/phone-a-settings.png` });
  // Captions off: mic capture stops; choosing a provider again restarts it.
  await a.select('#selProvider', 'off');
  await a.waitForFunction(() => window.__familycall.state.stt?.name === 'off' && window.__familycall.state.capture === null, { timeout: 5000 });
  await a.select('#selProvider', 'mock');
  await a.waitForFunction(() => window.__familycall.state.stt?.name === 'mock' && window.__familycall.state.capture !== null, { timeout: 5000 });
  console.log('A: captions turned off and back on');
  await a.click('#btnCloseSettings');
  await a.waitForSelector('#settingsPanel', { hidden: true });
  // Tapping the provider label opens the settings too.
  await a.click('#capBar');
  await a.waitForSelector('#settingsPanel', { visible: true });
  console.log('A: tapping the provider label opened settings');
  await a.click('#btnCloseSettings');
  await a.waitForFunction(() => [...document.querySelectorAll('#captions .cap-self .txt')].some((e) => /测试字幕/.test(e.textContent)), { timeout: 20000 });
  console.log('A: captions continue in Chinese after the settings change');

  await a.screenshot({ path: `${artifacts}/phone-a.png` });
  await b.screenshot({ path: `${artifacts}/phone-b.png` });

  // A generic room link (no name) auto-assigns a name and joins with one tap.
  const ctxC = await browser.createBrowserContext();
  const c = await ctxC.newPage();
  await c.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await c.goto(`${base}/?room=e2e-wait&simple=1`, { waitUntil: 'networkidle0' });
  await c.waitForSelector('#quickJoin', { visible: true });
  const autoName = await c.evaluate(() => window.__familycall.profile.name);
  if (!/^(Guest|家人)\d{3}$/.test(autoName || '')) fail(`expected auto-assigned name, got "${autoName}"`);
  console.log(`C: generic room link -> one-tap join screen with auto name "${autoName}"`);

  // Non-simple mode: the invite button is offered while waiting alone in the room.
  await c.goto(`${base}/?room=e2e-wait&simple=0`, { waitUntil: 'networkidle0' });
  await c.evaluate(() => { window.__familycall.captions.fadeMs = 1000; }); // speed up the 30s fade for the test
  await c.click('#setupForm button[type=submit]');
  await c.waitForFunction(() => document.getElementById('btnInviteCall').offsetParent !== null, { timeout: 10000 });
  console.log('C: room-link button available in the controls');

  // Caption bubbles fade out (default 30s after their last update; 1s here).
  // (C defaulted to Chinese, so the mock speaks Chinese here.)
  await c.waitForFunction(
    () => [...document.querySelectorAll('#captions .cap .txt')].some((e) => /(test caption|测试字幕) 1[.。]/.test(e.textContent)),
    { timeout: 20000 },
  );
  await c.waitForFunction(
    () => ![...document.querySelectorAll('#captions .cap .txt')].some((e) => /(test caption|测试字幕) 1[.。]/.test(e.textContent)),
    { timeout: 20000 },
  );
  console.log('C: caption faded out after the configured delay');
  await c.screenshot({ path: `${artifacts}/phone-c-waiting.png` });
  await ctxC.close();

  // Ringing: an idle phone on the start screen is rung when the other person joins its room.
  const ctxD = await browser.createBrowserContext();
  const d = await ctxD.newPage();
  await d.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await d.goto(`${base}/?room=e2e-ring&name=%E7%88%B8%E7%88%B8&simple=1&ui=zh`, { waitUntil: 'networkidle0' });
  await d.waitForSelector('#quickJoin', { visible: true });
  const ctxE = await browser.createBrowserContext();
  const e = await ctxE.newPage();
  await e.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  e.on('dialog', (dlg) => dlg.accept());
  await e.goto(`${base}/?room=e2e-ring&name=%E5%A5%B3%E5%84%BF&simple=1&ui=zh`, { waitUntil: 'networkidle0' });
  await e.click('#quickJoin');
  await d.waitForSelector('#incoming', { visible: true, timeout: 10000 });
  const from = await d.$eval('#incomingFrom', (el) => el.textContent);
  if (!from.includes('女儿')) fail(`incoming overlay should name the caller, got "${from}"`);
  console.log(`D: rang with "${from}"`);
  await d.screenshot({ path: `${artifacts}/phone-d-ringing.png` });
  await d.click('#btnAnswer');
  await d.waitForFunction(() => window.__familycall.state.connectionState === 'connected', { timeout: 20000 });
  console.log('D: answered and connected');
  await ctxE.close();
  await ctxD.close();

  await a.click('#btnHangup'); // confirm dialog auto-accepted
  await b.waitForFunction(() => document.getElementById('callStatus').textContent.includes('对方已离开'), { timeout: 10000 });
  console.log('B: saw peer-left after A hung up');
  await b.waitForFunction(() => document.getElementById('btnInviteCall').offsetParent !== null, { timeout: 5000 });
  console.log('B: room-link button available in the controls while waiting');
  await a.waitForSelector('#quickJoin', { visible: true });

  await a.click('#quickJoin');
  await Promise.all([waitConnected(a, 'A (rejoin)'), waitConnected(b, 'B (rejoin)')]);
  await b.waitForFunction(() => document.getElementById('callStatus').classList.contains('hidden'), { timeout: 10000 });
  console.log('rejoin: call re-established, status banner cleared');
} catch (err) {
  fail(err.stack || String(err));
  try {
    const dump = (page) => page.evaluate(() => {
      const s = window.__familycall.state;
      const pc = s.call?.pc;
      return {
        me: s.me, peer: s.peer?.id, polite: s.polite, inCall: s.inCall, connectionState: s.connectionState,
        pc: pc && { connection: pc.connectionState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState, signaling: pc.signalingState },
        status: document.getElementById('callStatus').textContent, sttOk: s.sttOk,
        ws: s.signaling?.connected,
      };
    });
    if (a) console.log('A state:', JSON.stringify(await dump(a)));
    if (b) console.log('B state:', JSON.stringify(await dump(b)));
    if (a) await a.screenshot({ path: `${artifacts}/fail-a.png` });
    if (b) await b.screenshot({ path: `${artifacts}/fail-b.png` });
  } catch (e) { console.log('dump failed', e.message); }
} finally {
  await browser.close();
  await app.close();
}

if (problems.length) {
  console.error(`E2E FAILED (${problems.length} problem(s))`);
  process.exit(1);
}
console.log('E2E PASSED');
