import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

let app;
let base;

before(async () => {
  app = createApp(loadConfig({
    PORT: '0', HOST: '127.0.0.1', STT_PROVIDER: 'mock', LOG_LEVEL: 'silent', ROOM_KEY: 'pw',
    TURN_URLS: 'turn:turn.example:3478', TURN_SECRET: 'abc',
  }));
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
  assert.equal(ja.iceServers.length, 1);
  assert.match(ja.iceServers[0].username, /:[0-9a-f]{8}$/);

  b.send({ type: 'join', room: 'fam', name: '爸爸', lang: 'zh-CN', key: 'pw' });
  const jb = await b.until('joined');
  assert.equal(jb.polite, true);
  assert.deepEqual(jb.peers, [{ id: ja.id, name: '女儿', lang: 'en-US' }]);
  const pj = await a.until('peer-joined');
  assert.deepEqual(pj.peer, { id: jb.id, name: '爸爸', lang: 'zh-CN' });
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
