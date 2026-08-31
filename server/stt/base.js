import WebSocket from 'ws';

const MAX_PENDING_BYTES = 5 * 48_000; // ~5 s of 24 kHz int16 audio buffered while (re)connecting

/**
 * Base class for WebSocket-based streaming transcribers.
 *
 * Subclasses implement:
 *   _open()            -> WebSocket
 *   _onOpen()          -> send session configuration
 *   _onMessage(msg)    -> parse provider events, call this.emit({key, text, final})
 *   _sendAudio(buf)    -> forward int16 PCM
 *   _beforeClose()     -> optional graceful close message
 *
 * Callbacks (opts): onText({key, text, final}), onStatus(ok, message), log
 */
export class WsTranscriber {
  static audioRate = 16000;
  static autoLang = false;

  constructor(opts) {
    this.opts = opts;
    this.lang = opts.lang;
    this.log = opts.log;
    this.ws = null;
    this.closed = false;
    this.pending = [];
    this.pendingBytes = 0;
    this.attempt = 0;
    this.lastAudioAt = 0;
    this.timer = null;
  }

  start() {
    this._connect();
    return this;
  }

  _connect() {
    let ws;
    try {
      ws = this._open();
    } catch (err) {
      this.opts.onStatus?.(false, err.message);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
      this.log?.debug('stt socket open');
      try {
        this._onOpen();
      } catch (err) {
        this.log?.error('stt onOpen failed', err);
      }
      for (const b of this.pending) this._sendAudio(b);
      this.pending = [];
      this.pendingBytes = 0;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      try {
        this._onMessage(msg);
      } catch (err) {
        this.log?.error('stt message handler failed', err);
      }
    });
    ws.on('error', (err) => {
      this.log?.warn('stt socket error:', err.message);
      this.opts.onStatus?.(false, err.message);
    });
    ws.on('close', (code, reason) => {
      if (this.ws === ws) this.ws = null;
      if (this.closed) return;
      if (this.cycling) {
        // Expected end-of-session (e.g. per-utterance providers); reconnect quietly.
        this.cycling = false;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this._connect(), 100);
        return;
      }
      this.log?.warn(`stt socket closed (${code} ${reason?.toString() || ''}); reconnecting`);
      this.opts.onStatus?.(false, `disconnected (${code})`);
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.closed) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._connect(), delay);
  }

  /** Feed int16 little-endian mono PCM at `audioRate`. */
  write(buf) {
    if (this.closed) return;
    this.lastAudioAt = Date.now();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendAudio(buf);
      return;
    }
    this.pending.push(buf);
    this.pendingBytes += buf.length;
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length) {
      this.pendingBytes -= this.pending.shift().length;
    }
  }

  emit(evt) {
    if (!evt.text) return;
    this.opts.onText?.(evt);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) this._beforeClose?.();
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
}
