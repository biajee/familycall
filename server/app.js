import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Rooms, publicPeer, sanitizeName, sanitizeRoom, sanitizeLang } from './rooms.js';
import { buildIceServers } from './turn.js';
import { createTranscriber, providerInfo, availableProviders } from './stt/index.js';
import { serveStatic } from './static.js';
import { createLogger } from './log.js';
import { createPush } from './push.js';

const MAX_AUDIO_FRAME = 64 * 1024;
const HEARTBEAT_MS = 20_000;

/**
 * Wire protocol (one WebSocket per phone, path /ws):
 *   text frames  = JSON control messages (join/signal/update/leave, caption/peer-* events)
 *   binary frames = the sender's own microphone as int16 mono PCM at `stt.audioRate`
 */
export function createApp(cfg, deps = {}) {
  const log = createLogger(cfg.logLevel);
  const push = deps.push || createPush(cfg, log);
  const rooms = new Rooms();
  const stt = providerInfo(cfg);
  const sttProviders = availableProviders(cfg);
  const sttFor = (client) => client.sttChoice || cfg.sttProvider;
  const OFF_INFO = { name: 'off', audioRate: 0, autoLang: true };
  const sttInfoFor = (client) => (client.sttChoice === 'off' ? OFF_INFO : providerInfo(cfg, sttFor(client)));
  const validChoice = (v) => typeof v === 'string' && (v === 'off' || sttProviders.includes(v));
  const clients = new Set();
  const publicDir = join(cfg.root, 'public');

  const json = (res, status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const readJson = (req, limit = 8192) => new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolveBody(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      return json(res, 200, { ok: true, provider: stt.name, rooms: rooms.rooms.size, clients: clients.size });
    }
    if (req.url === '/push/config') {
      return json(res, 200, { enabled: push.enabled, publicKey: push.publicKey });
    }
    if (req.url === '/push/subscribe' && req.method === 'POST') {
      let body;
      try { body = await readJson(req); } catch { return json(res, 400, { error: 'bad_json' }); }
      const roomId = sanitizeRoom(body.room);
      if (!roomId) return json(res, 400, { error: 'bad_room' });
      if (cfg.roomKey && body.key !== cfg.roomKey) return json(res, 403, { error: 'bad_key' });
      const device = String(body.device || '').slice(0, 32);
      if (!device || !body.subscription?.endpoint) return json(res, 400, { error: 'bad_subscription' });
      if (!push.enabled) return json(res, 503, { error: 'push_disabled' });
      push.subscribe(roomId, device, sanitizeName(body.name), body.subscription);
      log.info(`[push] ${device} subscribed to room "${roomId}" (${push.count(roomId)} devices)`);
      return json(res, 200, { ok: true });
    }
    serveStatic(publicDir, req, res);
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20 });

  const send = (client, msg) => {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg));
  };
  const broadcast = (roomId, msg, except = null) => {
    for (const p of rooms.members(roomId)) if (p !== except) send(p, msg);
  };
  const sendError = (client, code, message) => send(client, { type: 'error', code, message });

  /** One transcription session per speaking client; maps provider utterance keys to segment ids. */
  class CaptionStream {
    constructor(client) {
      this.client = client;
      this.provider = sttFor(client);
      this.segs = new Map();
      this.idleTimer = null;
      this.tx = createTranscriber(cfg, {
        lang: client.lang,
        log: log.child(`[stt ${client.id}]`),
        onText: (evt) => this.onText(evt),
        onStatus: (ok, message) => send(client, { type: 'stt-status', ok, message, provider: this.provider }),
      }, this.provider);
      this.touch();
    }

    onText({ key, text, final }) {
      let seg = this.segs.get(key);
      if (seg === undefined) {
        // Segment ids live on the client so they never restart when the
        // transcriber is recreated (language/provider change) — a reused id
        // would overwrite an old bubble on the phones.
        seg = this.client.nextSeg++;
        this.segs.set(key, seg);
        if (this.segs.size > 100) this.segs.delete(this.segs.keys().next().value);
      }
      // Keys are kept after a final: a provider may amend a finalized caption
      // (e.g. xfyun's late punctuation) and it must map to the same segment.
      if (!this.client.room) return;
      broadcast(this.client.room, {
        type: 'caption', speaker: this.client.id, seg, text, final, lang: this.client.lang,
      });
    }

    write(buf) {
      this.tx.write(buf);
      this.touch();
    }

    touch() {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.client.closeStt('idle'), cfg.sttIdleCloseMs);
    }

    close() {
      clearTimeout(this.idleTimer);
      this.tx.close();
    }
  }

  function makeClient(ws, req) {
    const client = {
      id: randomUUID().slice(0, 8),
      ws,
      ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress,
      room: null,
      name: 'Guest',
      lang: 'zh-CN',
      polite: false,
      stt: null,
      sttChoice: '', // '' = server default provider
      sttPrev: '', // choice to restore when the other side turns our captions back on
      nextSeg: 0,
      device: '', // per-phone id from the app (localStorage); excludes the caller from its own ring
      listening: null, // room this idle phone wants to be rung for
      alive: true,
      closeStt(reason) {
        if (!this.stt) return;
        log.debug(`[${this.id}] closing stt (${reason})`);
        this.stt.close();
        this.stt = null;
      },
    };
    return client;
  }

  /** Idle phones (app open on the start screen) that asked to be rung for a room. */
  const listeners = (roomId, exceptDevice) => [...clients]
    .filter((c) => c.listening === roomId && !c.room && !(exceptDevice && c.device === exceptDevice));

  function ringRoom(roomId, caller) {
    const payload = { type: 'ring', room: roomId, from: caller.name };
    for (const l of listeners(roomId, caller.device)) send(l, payload);
    const q = new URLSearchParams({ room: roomId, simple: '1', ring: '1', from: caller.name });
    if (cfg.roomKey) q.set('key', cfg.roomKey);
    push.notifyRoom(roomId, {
      title: '家庭通话 · Family Call',
      body: `${caller.name} 正在呼叫你 · ${caller.name} is calling`,
      url: `/?${q.toString()}`,
    }, caller.device).then((n) => {
      if (n) log.info(`[${caller.id}] rang ${n} device(s) in room "${roomId}"`);
    }).catch((err) => log.warn('push failed:', err.message));
  }

  function cancelRing(roomId) {
    for (const l of listeners(roomId)) send(l, { type: 'ring-cancel', room: roomId });
  }

  function onListen(client, msg) {
    const roomId = sanitizeRoom(msg.room);
    if (!roomId) return sendError(client, 'bad_room', 'Invalid room name');
    if (cfg.roomKey && msg.key !== cfg.roomKey) return sendError(client, 'bad_key', 'Wrong room key');
    if (typeof msg.device === 'string') client.device = msg.device.slice(0, 32);
    client.listening = roomId;
    send(client, { type: 'listening', room: roomId });
    // Someone is already waiting alone in the room: ring right away.
    const waiting = rooms.members(roomId);
    if (waiting.length === 1 && waiting[0].device !== client.device) {
      send(client, { type: 'ring', room: roomId, from: waiting[0].name });
    }
  }

  function doLeave(client) {
    client.closeStt('leave');
    if (!client.room) return;
    const roomId = client.room;
    client.room = null;
    const remaining = rooms.leave(roomId, client.id);
    for (const p of remaining) send(p, { type: 'peer-left', id: client.id });
    if (remaining.length === 0) cancelRing(roomId); // the caller gave up: stop ringing idle phones
    log.info(`[${client.id}] left room "${roomId}" (${remaining.length} remaining)`);
  }

  function onJoin(client, msg) {
    const roomId = sanitizeRoom(msg.room);
    if (!roomId) return sendError(client, 'bad_room', 'Invalid room name');
    if (cfg.roomKey && msg.key !== cfg.roomKey) return sendError(client, 'bad_key', 'Wrong room key');
    if (client.room) doLeave(client);
    client.name = sanitizeName(msg.name);
    client.lang = sanitizeLang(msg.lang);
    if (typeof msg.device === 'string') client.device = msg.device.slice(0, 32);
    if (validChoice(msg.stt)) client.sttChoice = msg.stt;
    client.listening = null;
    const r = rooms.join(roomId, client);
    if (!r.ok) return sendError(client, r.code, r.code === 'room_full' ? 'Room is full' : r.code);
    client.room = roomId;
    // The peer already in the room becomes impolite; every newcomer is polite (perfect negotiation).
    for (const other of r.others) other.polite = false;
    send(client, {
      type: 'joined',
      id: client.id,
      room: roomId,
      polite: client.polite,
      peers: r.others.map(publicPeer),
      iceServers: buildIceServers(cfg, client.id),
      stt: sttInfoFor(client),
      sttProviders,
    });
    for (const other of r.others) send(other, { type: 'peer-joined', peer: publicPeer(client), polite: false });
    if (r.others.length === 0) ringRoom(roomId, client); // first in: ring the other phone(s)
    else cancelRing(roomId); // room is now full: stop ringing anyone else
    log.info(`[${client.id}] "${client.name}" (${client.lang}) joined room "${roomId}" from ${client.ip}; peers=${r.others.length + 1}`);
  }

  function onSignal(client, msg) {
    if (!client.room || !msg.data) return;
    const target = rooms.members(client.room).find((p) => p.id === msg.to);
    if (!target) return;
    send(target, { type: 'signal', from: client.id, data: msg.data });
  }

  function onUpdate(client, msg) {
    if (typeof msg.name === 'string') client.name = sanitizeName(msg.name);
    if (typeof msg.lang === 'string') {
      const lang = sanitizeLang(msg.lang);
      if (lang !== client.lang) {
        client.lang = lang;
        client.closeStt('language changed');
      }
    }
    if (typeof msg.stt === 'string') {
      const choice = validChoice(msg.stt) ? msg.stt : '';
      if (choice !== client.sttChoice) {
        if (choice === 'off') client.sttPrev = client.sttChoice;
        client.sttChoice = choice;
        client.closeStt(choice === 'off' ? 'captions off' : 'provider changed');
        // The new provider may use a different audio rate (or be "off"): tell the phone.
        send(client, { type: 'stt-info', stt: sttInfoFor(client) });
      }
    }
    if (client.room) broadcast(client.room, { type: 'peer-updated', peer: publicPeer(client) }, client);
  }

  /** Either side can switch the OTHER phone's transcription off/on (e.g. the caller
   *  hears Dad fine and does not need his speech transcribed). */
  function onPeerStt(client, msg) {
    if (!client.room) return;
    const peer = rooms.members(client.room).find((p) => p !== client);
    if (!peer) return;
    const off = !!msg.off;
    if (off && peer.sttChoice !== 'off') {
      peer.sttPrev = peer.sttChoice;
      peer.sttChoice = 'off';
      peer.closeStt('captions turned off by peer');
      send(peer, { type: 'stt-info', stt: sttInfoFor(peer), by: 'peer' });
    } else if (!off && peer.sttChoice === 'off') {
      peer.sttChoice = peer.sttPrev || '';
      send(peer, { type: 'stt-info', stt: sttInfoFor(peer), by: 'peer' });
    }
    send(client, { type: 'peer-updated', peer: publicPeer(peer) });
  }

  function onAudio(client, buf) {
    if (!client.room || buf.length === 0 || buf.length > MAX_AUDIO_FRAME) return;
    if (client.sttChoice === 'off') return; // captions turned off by this phone
    if (!client.stt) {
      try {
        client.stt = new CaptionStream(client);
      } catch (err) {
        log.error(`[${client.id}] cannot start transcriber:`, err.message);
        send(client, { type: 'stt-status', ok: false, message: err.message, provider: sttFor(client) });
        return;
      }
    }
    client.stt.write(buf);
  }

  wss.on('connection', (ws, req) => {
    const client = makeClient(ws, req);
    clients.add(client);
    log.debug(`[${client.id}] connected from ${client.ip}`);
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return onAudio(client, data);
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return sendError(client, 'bad_json', 'Malformed message');
      }
      switch (msg.type) {
        case 'join': return onJoin(client, msg);
        case 'listen': return onListen(client, msg);
        case 'peer-stt': return onPeerStt(client, msg);
        case 'signal': return onSignal(client, msg);
        case 'update': return onUpdate(client, msg);
        case 'leave': return doLeave(client);
        case 'ping': return send(client, { type: 'pong', t: msg.t });
        default: return sendError(client, 'bad_type', `Unknown message type "${msg.type}"`);
      }
    });
    ws.on('close', () => {
      doLeave(client);
      clients.delete(client);
      log.debug(`[${client.id}] disconnected`);
    });
    ws.on('error', (err) => log.warn(`[${client.id}] socket error:`, err.message));
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        log.warn(`[${client.id}] heartbeat timeout; terminating`);
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      try { client.ws.ping(); } catch { /* ignore */ }
    }
  }, HEARTBEAT_MS);

  function listen() {
    return new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, () => {
        server.off('error', reject);
        resolvePromise(server.address());
      });
    });
  }

  function close() {
    clearInterval(heartbeat);
    for (const client of clients) {
      client.closeStt('shutdown');
      client.ws.terminate();
    }
    return new Promise((resolvePromise) => {
      wss.close(() => server.close(() => resolvePromise()));
    });
  }

  return { server, wss, rooms, stt, log, listen, close };
}
