/** WebSocket client with automatic reconnection. Text = JSON control, binary = PCM audio. */
export class Signaling {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.closed = false;
    this.attempt = 0;
    this.timer = null;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onfail = null;
  }

  connect() {
    this.closed = false;
    this._open();
  }

  _open() {
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.onopen?.();
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.onmessage?.(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      this.onclose?.();
      this._retry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  _retry() {
    clearTimeout(this.timer);
    if (this.attempt >= 40) { this.onfail?.(); return; }
    const delay = Math.min(10_000, 500 * 2 ** Math.min(this.attempt++, 4));
    this.timer = setTimeout(() => this._open(), delay);
  }

  /** Force a fresh connection (the server treats it as leave + join). */
  reconnect() {
    this.ws?.close();
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  send(obj) {
    if (!this.connected) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  /** Drops audio when the socket is backed up instead of building unbounded latency. */
  sendBinary(buf) {
    if (!this.connected || this.ws.bufferedAmount > 256 * 1024) return false;
    this.ws.send(buf);
    return true;
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
