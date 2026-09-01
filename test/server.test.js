import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

let app;
let base;
const pushed = []; // fake Web Push transport
const subscribed = [];
const fakePush = {
  enabled: true,
  publicKey: 'test-public-key',
  subscribe: (room, device, name, subscription) => subscribed.push({ room, device, name, endpoint: subscription.endpoint }),
  count: () => subscribed.length,
  notifyRoom: async (room, payload, except) => { pushed.push({ room, payload, except }); return 1; },
};

before(async () => {
  app = createApp(loadConfig({
    PORT: '0', HOST: '127.0.0.1', STT_PROVIDER: 'mock', LOG_LEVEL: 'silent', ROOM_KEY: 'pw',
    TURN_URLS: 'turn:turn.example:3478', TURN_SECRET: 'abc',
  }), { push: fakePush });
  const addr = await app.listen();
  base = `127.0.0.1:${addr.port}`;
});

after(() => app.close());

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
  return { ws, next, until, open, send: (o) => ws.send(JSON.stringify(o)) };
}

test('health endpoint and static files are served', async () => {
  const h = await fetch(`http://${base}/healthz`).then((r) => r.json());
  assert.equal(h.ok, true);
  assert.equal(h.provider, 'mock');
  const html = await fetch(`http://${base}/`).then((r) => r.text());
  assert.match(html, /<title>家庭通话/);
  const man = await fetch(`http://${base}/manifest.webmanifest?room=fam&name=Dad`).then((r) => r.json());
  assert.equal(man.start_url, '/?room=fam&name=Dad');
  const traversal = await fetch(`http://${base}/..%2F..%2Fpackage.json`);
  assert.ok([403, 404].includes(traversal.status));
});

test('join / signal / captions / leave flow', async () => {
  const a = client();
  const b = client();
  await Promise.all([a.open, b.open]);

  a.send({ type: 'join', room: 'Fam', name: '女儿', lang: 'en-US', key: 'pw' });
  const ja = await a.until('joined');
  assert.equal(ja.room, 'fam');
  assert.equal(ja.polite, false);
  assert.deepEqual(ja.peers, []);
  assert.equal(ja.stt.name, 'mock');
  assert.equal(ja.stt.audioRate, 16000);
  assert.deepEqual(ja.sttProviders, ['mock']);
  assert.equal(ja.iceServers.length, 1);
  assert.match(ja.iceServers[0].username, /:[0-9a-f]{8}$/);

  b.send({ type: 'join', room: 'fam', name: '爸爸', lang: 'zh-CN', key: 'pw' });
  const jb = await b.until('joined');
  assert.equal(jb.polite, true);
  assert.deepEqual(jb.peers, [{ id: ja.id, name: '女儿', lang: 'en-US', captions: true }]);
  const pj = await a.until('peer-joined');
  assert.deepEqual(pj.peer, { id: jb.id, name: '爸爸', lang: 'zh-CN', captions: true });
  assert.equal(pj.polite, false);

  // signaling relay
  a.send({ type: 'signal', to: jb.id, data: { description: { type: 'offer', sdp: 'x' } } });
  const sig = await b.until('signal');
  assert.equal(sig.from, ja.id);
  assert.deepEqual(sig.data, { description: { type: 'offer', sdp: 'x' } });

  // audio from A -> captions to both, attributed to A, in A's language
  const chunk = Buffer.alloc(3200);
  for (let i = 0; i < 20; i++) a.ws.send(chunk);
  const statusA = await a.until('stt-status');
  assert.equal(statusA.ok, true);
  const capB = await b.until('caption');
  assert.equal(capB.speaker, ja.id);
  assert.equal(capB.final, false);
  assert.equal(capB.seg, 0);
  const capBFinal = await b.until('caption');
  assert.equal(capBFinal.final, true);
  assert.match(capBFinal.text, /test caption 1\.$/);
  const capA = await a.until('caption');
  assert.equal(capA.speaker, ja.id);

  // language change restarts the transcriber with the new language
  a.send({ type: 'update', lang: 'zh-CN' });
  const upd = await b.until('peer-updated');
  assert.equal(upd.peer.lang, 'zh-CN');
  for (let i = 0; i < 20; i++) a.ws.send(chunk);
  await a.until('stt-status');
  let cap;
  do cap = await b.until('caption'); while (!cap.final);
  assert.match(cap.text, /测试字幕/);

  // choosing a provider from the settings restarts the transcriber and reports the new rate
  a.send({ type: 'update', stt: 'mock' });
  const info = await a.until('stt-info');
  assert.deepEqual(info.stt, { name: 'mock', audioRate: 16000, autoLang: true });
  a.send({ type: 'update', stt: 'not-a-provider' }); // unknown -> falls back to the default
  const info2 = await a.until('stt-info');
  assert.equal(info2.stt.name, 'mock');

  // captions can be turned off per phone: audio is dropped until a provider is chosen again
  a.send({ type: 'update', stt: 'off' });
  assert.deepEqual((await a.until('stt-info')).stt, { name: 'off', audioRate: 0, autoLang: true });
  for (let i = 0; i < 20; i++) a.ws.send(chunk);
  await assert.rejects(b.until('caption', 700), /timeout/, 'no captions while off');
  a.send({ type: 'update', stt: 'mock' });
  assert.equal((await a.until('stt-info')).stt.name, 'mock');

  // either side can switch the other phone's transcription off and back on
  a.send({ type: 'peer-stt', off: true });
  const offInfo = await b.until('stt-info');
  assert.equal(offInfo.stt.name, 'off');
  assert.equal(offInfo.by, 'peer');
  let pu = await a.until('peer-updated');
  assert.equal(pu.peer.captions, false);
  a.send({ type: 'peer-stt', off: false });
  assert.equal((await b.until('stt-info')).stt.name, 'mock');
  pu = await a.until('peer-updated');
  assert.equal(pu.peer.captions, true);

  // third participant is rejected
  const c = client();
  await c.open;
  c.send({ type: 'join', room: 'fam', name: 'x', lang: 'en-US', key: 'pw' });
  const err = await c.until('error');
  assert.equal(err.code, 'room_full');
  c.ws.close();

  // leaving notifies the peer
  b.send({ type: 'leave' });
  const left = await a.until('peer-left');
  assert.equal(left.id, jb.id);
  a.ws.close();
  b.ws.close();
});

test('wrong room key and bad room are rejected', async () => {
  const c = client();
  await c.open;
  c.send({ type: 'join', room: 'fam', name: 'x', lang: 'en-US', key: 'nope' });
  assert.equal((await c.until('error')).code, 'bad_key');
  c.send({ type: 'join', room: '!!!', name: 'x', lang: 'en-US', key: 'pw' });
  assert.equal((await c.until('error')).code, 'bad_room');
  c.ws.send('not json');
  assert.equal((await c.until('error')).code, 'bad_json');
  c.ws.close();
});

test('ringing: idle phones get ring/ring-cancel and subscribed phones get a push', async () => {
  // push opt-in over HTTP
  const cfgRes = await fetch(`http://${base}/push/config`).then((r) => r.json());
  assert.deepEqual(cfgRes, { enabled: true, publicKey: 'test-public-key' });
  const sub = await fetch(`http://${base}/push/subscribe`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room: 'ring', key: 'pw', name: '爸爸', device: 'dad-phone', subscription: { endpoint: 'https://push.example/abc', keys: {} } }),
  });
  assert.equal(sub.status, 200);
  assert.deepEqual(subscribed.at(-1), { room: 'ring', device: 'dad-phone', name: '爸爸', endpoint: 'https://push.example/abc' });
  const bad = await fetch(`http://${base}/push/subscribe`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room: 'ring', key: 'wrong', device: 'x', subscription: { endpoint: 'e' } }),
  });
  assert.equal(bad.status, 403);

  // Dad's app is open on the start screen: it listens for its room
  const dad = client();
  await dad.open;
  dad.send({ type: 'listen', room: 'ring', key: 'pw', device: 'dad-phone' });
  assert.equal((await dad.until('listening')).room, 'ring');

  // daughter starts a call -> Dad's open app rings, and his subscribed phone gets a push (not her own)
  const daughter = client();
  await daughter.open;
  daughter.send({ type: 'join', room: 'ring', name: '女儿', lang: 'zh-CN', key: 'pw', device: 'her-phone' });
  await daughter.until('joined');
  const ring = await dad.until('ring');
  assert.equal(ring.from, '女儿');
  assert.equal(ring.room, 'ring');
  assert.deepEqual(pushed.at(-1).except, 'her-phone');
  assert.match(pushed.at(-1).payload.body, /女儿/);
  assert.match(pushed.at(-1).payload.url, /room=ring.*ring=1/);

  // a phone that starts listening while she is already waiting is rung immediately
  const late = client();
  await late.open;
  late.send({ type: 'listen', room: 'ring', key: 'pw', device: 'late-phone' });
  await late.until('listening');
  assert.equal((await late.until('ring')).from, '女儿');

  // she gives up -> ringing stops
  daughter.send({ type: 'leave' });
  await dad.until('ring-cancel');
  await late.until('ring-cancel');
  dad.ws.close(); late.ws.close(); daughter.ws.close();
});

test('socket close leaves the room', async () => {
  const a = client();
  const b = client();
  await Promise.all([a.open, b.open]);
  a.send({ type: 'join', room: 'r2', name: 'a', lang: 'en-US', key: 'pw' });
  await a.until('joined');
  b.send({ type: 'join', room: 'r2', name: 'b', lang: 'en-US', key: 'pw' });
  await b.until('joined');
  await a.until('peer-joined');
  b.ws.terminate();
  await a.until('peer-left');
  assert.equal(app.rooms.members('r2').length, 1);
  a.ws.close();
});
