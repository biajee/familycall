import crypto from 'node:crypto';
import WebSocket from 'ws';
import { WsTranscriber } from './base.js';

/** RTASR handshake signature: Base64(HmacSHA1(MD5hex(appid + ts), apiKey)). */
export function xfyunSigna(appId, apiKey, ts) {
  const base = crypto.createHash('md5').update(appId + ts).digest('hex');
  return crypto.createHmac('sha1', apiKey).update(base).digest('base64');
}

export function xfyunUrl(cfg, lang, now = Date.now()) {
  const ts = String(Math.floor(now / 1000));
  const p = new URLSearchParams({ appid: cfg.appId, ts, signa: xfyunSigna(cfg.appId, cfg.apiKey, ts) });
  // Default model is Mandarin with embedded English; pure English needs the
  // multi-language option enabled on the xfyun account.
  if (lang === 'en-US') p.set('lang', 'en');
  return `${cfg.url}?${p.toString()}`;
}

const FRAME_BYTES = 1280; // RTASR wants small binary frames (≈40 ms of 16 kHz int16)

/**
 * iFlytek (xfyun.cn) 实时语音转写 RTASR: continuous streaming transcription.
 * Docs: https://www.xfyun.cn/doc/asr/rtasr/API.html
 */
export class XfyunTranscriber extends WsTranscriber {
  static audioRate = 16000;
  static autoLang = true;

  constructor(opts) {
    super(opts);
    this.cfg = opts.cfg.xfyun;
    this.utt = 0; // RTASR interims carry the whole current sentence; we key them per utterance
  }

  _open() {
    if (!this.cfg.appId || !this.cfg.apiKey) throw new Error('XFYUN_APP_ID / XFYUN_API_KEY is not set');
    return new WebSocket(xfyunUrl(this.cfg, this.lang));
  }

  _onOpen() {
    // No session config frame: RTASR starts on connection and answers {action:"started"}.
  }

  _sendAudio(buf) {
    for (let o = 0; o < buf.length; o += FRAME_BYTES) this.ws.send(buf.subarray(o, o + FRAME_BYTES));
  }

  _onMessage(msg) {
    switch (msg.action) {
      case 'started':
        this.opts.onStatus?.(true, 'ok');
        break;
      case 'error':
        this.log?.error('xfyun error:', msg.code, msg.desc);
        this.opts.onStatus?.(false, msg.desc || `error ${msg.code}`);
        break;
      case 'result': {
        let d;
        try { d = JSON.parse(msg.data); } catch { return; }
        const st = d?.cn?.st;
        if (!st) return;
        const text = (st.rt || [])
          .flatMap((r) => r.ws || [])
          .map((w) => w.cw?.[0]?.w || '')
          .join('')
          .trim();
        const final = String(st.type) === '0';
        const key = `u${this.utt}`;
        if (final) this.utt++;
        this.emit({ key, text, final });
        break;
      }
      default:
        break;
    }
  }

  _beforeClose() {
    try { this.ws.send('{"end": true}'); } catch { /* ignore */ }
  }
}
