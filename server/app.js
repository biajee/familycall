import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Rooms, publicPeer, sanitizeName, sanitizeRoom, sanitizeLang } from './rooms.js';
import { buildIceServers } from './turn.js';
import { createTranscriber, providerInfo } from './stt/index.js';
import { serveStatic } from './static.js';
import { createLogger } from './log.js';

const MAX_AUDIO_FRAME = 64 * 1024;
const HEARTBEAT_MS = 20_000;

/**
 * Wire protocol (one WebSocket per phone, path /ws):
 *   text frames  = JSON control messages (join/signal/update/leave, caption/peer-* events)
 *   binary frames = the sender's own microphone as int16 mono PCM at `stt.audioRate`
 */
export function createApp(cfg) {
  const log = createLogger(cfg.logLevel);
  const rooms = new Rooms();
  const stt = providerInfo(cfg);
  const clients = new Set();
  const publicDir = join(cfg.root, 'public');

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, provider: stt.name, rooms: rooms.rooms.size, clients: clients.size }));
      return;
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
      this.segs = new Map();
      this.nextSeg = 0;
      this.idleTimer = null;
      this.tx = createTranscriber(cfg, {
        lang: client.lang,
        log: log.child(`[stt ${client.id}]`),
        onText: (evt) => this.onText(evt),
        onStatus: (ok, message) => send(client, { type: 'stt-status', ok, message, provider: stt.name }),
      });
      this.touch();
    }

    onText({ key, text, final }) {
      let seg = this.segs.get(key);
      if (seg === undefined) {
        seg = this.nextSeg++;
        this.segs.set(key, seg);
        if (this.segs.size > 100) this.segs.delete(this.segs.keys().next().value);
      }
      if (final) this.segs.delete(key);
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

  function doLeave(client) {
    client.closeStt('leave');
    if (!client.room) return;
    const roomId = client.room;
    client.room = null;
    const remaining = rooms.leave(roomId, client.id);
    for (const p of remaining) send(p, { type: 'peer-left', id: client.id });
    log.info(`[${client.id}] left room "${roomId}" (${remaining.length} remaining)`);
  }

  function onJoin(client, msg) {
    const roomId = sanitizeRoom(msg.room);
    if (!roomId) return sendError(client, 'bad_room', 'Invalid room name');
    if (cfg.roomKey && msg.key !== cfg.roomKey) return sendError(client, 'bad_key', 'Wrong room key');
    if (client.room) doLeave(client);
    client.name = sanitizeName(msg.name);
    client.lang = sanitizeLang(msg.lang);
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
      stt,
    });
    for (const other of r.others) send(other, { type: 'peer-joined', peer: publicPeer(client), polite: false });
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
    if (client.room) broadcast(client.room, { type: 'peer-updated', peer: publicPeer(client) }, client);
  }

  function onAudio(client, buf) {
    if (!client.room || buf.length === 0 || buf.length > MAX_AUDIO_FRAME) return;
    if (!client.stt) {
      try {
        client.stt = new CaptionStream(client);
      } catch (err) {
        log.error(`[${client.id}] cannot start transcriber:`, err.message);
        send(client, { type: 'stt-status', ok: false, message: err.message, provider: stt.name });
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
