/**
 * End-to-end test: two headless Chrome "phones" (separate browser contexts, fake camera + mic)
 * join the same room, establish a WebRTC call, exchange captions via the mock transcriber,
 * hang up and re-join. Needs puppeteer (npm i -D puppeteer) — also found in a sibling
 * project's node_modules as a convenience.
 */
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadPuppeteer() {
  const candidates = ['puppeteer', resolve(here, '../../../turtlebot/node_modules/puppeteer')];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }
  throw new Error('puppeteer not found: run `npm i -D puppeteer`');
}

const puppeteer = loadPuppeteer();
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
  `${c.classList.contains('cap-self') ? 'self' : 'peer'}${c.classList.contains('interim') ? '(interim)' : ''} ${c.querySelector('.mark').textContent} ${c.querySelector('.txt').textContent}`));

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

  const bPeerMark = await b.evaluate(() => document.querySelector('#captions .cap-peer .mark')?.textContent);
  if (bPeerMark !== '<') fail(`B should mark incoming captions "<", got "${bPeerMark}"`);
  const aSelfMark = await a.evaluate(() => document.querySelector('#captions .cap-self .mark')?.textContent);
  if (aSelfMark !== '>') fail(`A should mark own captions ">", got "${aSelfMark}"`);

  for (const [label, page] of [['A', a], ['B', b]]) {
    const ok = await page.evaluate(() => window.__familycall.state.sttOk);
    if (ok !== true) fail(`${label}: STT status is ${ok}`);
  }

  const invite = await a.evaluate(() => window.__familycall.inviteLink());
  const wantInvite = ['room=e2e-room', 'lang=zh-CN', 'ui=zh', 'simple=1', 'font=40', `name=${encodeURIComponent('爸爸')}`];
  for (const part of wantInvite) {
    if (!invite || !invite.includes(part)) fail(`invite link missing "${part}": ${invite}`);
  }
  console.log('A invite link:', invite);

  const before = await b.evaluate(() => getComputedStyle(document.getElementById('captions')).fontSize);
  await b.click('#btnFontUp');
  const after = await b.evaluate(() => getComputedStyle(document.getElementById('captions')).fontSize);
  console.log(`B caption font: ${before} -> ${after}`);
  if (parseFloat(after) <= parseFloat(before)) fail('A+ did not enlarge captions');

  await a.click('#btnMute');
  const muted = await a.evaluate(() => window.__familycall.state.localStream.getAudioTracks()[0].enabled === false);
  if (!muted) fail('mute did not disable the audio track');
  await a.click('#btnMute');

  await a.screenshot({ path: `${artifacts}/phone-a.png` });
  await b.screenshot({ path: `${artifacts}/phone-b.png` });

  await a.click('#btnHangup'); // confirm dialog auto-accepted
  await b.waitForFunction(() => document.getElementById('callStatus').textContent.includes('对方已离开'), { timeout: 10000 });
  console.log('B: saw peer-left after A hung up');
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
