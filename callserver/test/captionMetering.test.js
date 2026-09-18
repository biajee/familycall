import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

// A stand-in for the FamilyCall shell: answers validate-room with whatever
// allowance the current test sets, and records the usage reports it receives.
const SECRET = 'test-secret';
const shell = { allowance: null, validations: [], captionReports: [], callReports: [] };
let shellServer;
let app;
let base;

before(async () => {
  shellServer = http.createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${SECRET}`) return reply(401, { error: 'Unauthorized' });
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/internal/validate-room') {
      const slug = url.searchParams.get('slug');
      shell.validations.push(slug);
      if (slug === 'ghost') return reply(404, { error: 'Not found' });
      return reply(200, { ok: true, roomId: 'r1', captionSecondsRemaining: shell.allowance });
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (url.pathname === '/api/internal/caption-usage') shell.captionReports.push(JSON.parse(body));
      if (url.pathname === '/api/internal/call-usage') shell.callReports.push(JSON.parse(body));
      reply(200, { ok: true });
    });
  });
  await new Promise((resolve) => shellServer.listen(0, '127.0.0.1', resolve));

  app = createApp(loadConfig({
    PORT: '0', HOST: '127.0.0.1', STT_PROVIDER: 'mock', LOG_LEVEL: 'silent',
    FAMILYCALL_SHELL_URL: `http://127.0.0.1:${shellServer.address().port}`,
    FAMILYCALL_INTERNAL_SECRET: SECRET,
  }));
  base = `127.0.0.1:${(await app.listen()).port}`;
});

after(async () => {
  await app.close();
  await new Promise((resolve) => shellServer.close(resolve));
});

function client() {
  const ws = new WebSocket(`ws://${base}/ws`);
  const queue = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  const next = (timeout = 3000) => new Promise((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeout);
    waiters.push((m) => { clearTimeout(t); resolve(m); });
  });
  const until = async (type, timeout = 3000) => {
    for (;;) {
      const m = await next(timeout);
      if (m.type === type) return m;
    }
  };
  const open = new Promise((resolve) => ws.once('open', resolve));
  return { ws, until, open, send: (o) => ws.send(JSON.stringify(o)) };
}

async function joinRoom(room, name = 'Dad') {
  const c = client();
  await c.open;
  c.send({ type: 'join', room, name, lang: 'zh-CN' });
  c.joined = await c.until('joined');
  return c;
}

/** One second of int16 mono silence at the rate this phone's provider wants. */
const oneSecond = (c) => Buffer.alloc(c.joined.stt.audioRate * 2);

async function waitFor(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const quiet = (c, type, ms = 300) => c.until(type, ms).then(
  () => { throw new Error(`unexpected ${type}`); },
  (err) => { if (err.message !== 'timeout waiting for message') throw err; },
);

test('when the allowance runs out, captions stop for both phones but the call carries on', async () => {
  shell.allowance = 2;
  const a = await joinRoom('room-one', 'Daughter');
  const b = await joinRoom('room-one', 'Dad');

  for (let i = 0; i < 3; i++) a.ws.send(oneSecond(a)); // 2s allowed, the 3rd refused
  const [ea, eb] = await Promise.all([a.until('error'), b.until('error')]);
  assert.equal(ea.code, 'caption_limit');
  assert.equal(eb.code, 'caption_limit');
  assert.match(ea.message, /familycall\.zbackroom\.com/);

  assert.equal(a.ws.readyState, WebSocket.OPEN, 'the socket must stay open');
  a.send({ type: 'ping', t: 1 });
  assert.equal((await a.until('pong')).t, 1, 'signaling keeps working after captions stop');

  a.ws.send(oneSecond(a));
  await quiet(a, 'error'); // told once, not on every dropped frame

  a.send({ type: 'leave' });
  await waitFor(() => shell.captionReports.some((r) => r.slug === 'room-one'));
  assert.deepEqual(shell.captionReports.find((r) => r.slug === 'room-one'), { slug: 'room-one', seconds: 2 });

  b.send({ type: 'leave' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(shell.captionReports.filter((r) => r.slug === 'room-one').length, 1, 'b sent no audio, so reports nothing');
  a.ws.close();
  b.ws.close();
});

test("a later joiner does not reset the room's allowance", async () => {
  shell.allowance = 2;
  const a = await joinRoom('room-two', 'Daughter');
  a.ws.send(oneSecond(a)); // 1s left

  shell.allowance = 2; // the shell has not heard about a's second yet, so it would still say 2
  const b = await joinRoom('room-two', 'Dad');
  assert.equal(shell.validations.filter((s) => s === 'room-two').length, 2, 'b was validated too');

  a.ws.send(oneSecond(a)); // allowed: takes it to 0
  a.ws.send(oneSecond(a)); // refused, which only happens if b's join did not refill it
  assert.equal((await a.until('error')).code, 'caption_limit');
  a.ws.close();
  b.ws.close();
});

test('an unlimited plan (null) is never cut off, but usage is still reported', async () => {
  shell.allowance = null;
  const a = await joinRoom('room-three');
  for (let i = 0; i < 3; i++) a.ws.send(oneSecond(a));
  await quiet(a, 'error');

  a.send({ type: 'leave' });
  await waitFor(() => shell.captionReports.some((r) => r.slug === 'room-three'));
  assert.equal(shell.captionReports.find((r) => r.slug === 'room-three').seconds, 3);
  a.ws.close();
});

test('an owner with no time left can still join and call; only captions are refused', async () => {
  shell.allowance = 0;
  const a = await joinRoom('room-four'); // joined: not rejected
  a.ws.send(oneSecond(a));
  assert.equal((await a.until('error')).code, 'caption_limit');

  a.send({ type: 'leave' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(shell.captionReports.some((r) => r.slug === 'room-four'), false, 'nothing was transcribed, so nothing to report');
  a.ws.close();
});

test('turning captions off costs nothing', async () => {
  shell.allowance = 5;
  const a = await joinRoom('room-five');
  a.send({ type: 'update', stt: 'off' });
  await a.until('stt-info');
  for (let i = 0; i < 3; i++) a.ws.send(oneSecond(a));

  a.send({ type: 'leave' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(shell.captionReports.some((r) => r.slug === 'room-five'), false);
  a.ws.close();
});

test('a room the shell does not know is still refused (404)', async () => {
  const c = client();
  await c.open;
  c.send({ type: 'join', room: 'ghost', name: 'X', lang: 'zh-CN' });
  assert.equal((await c.until('error')).code, 'not_found');
  c.ws.close();
});
