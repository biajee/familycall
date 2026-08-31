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

/** "2025-09-04T15:38:07+0000" — the utc format the 大模型版 handshake expects. */
export function xfyunUtc(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+0000`;
}

/**
 * 实时语音转写大模型 (new_rta) handshake: params sorted alphabetically, each
 * key/value URL-encoded, joined k=v&, HmacSHA1 with the APISecret, base64.
 * Docs: https://www.xfyun.cn/doc/spark/asr_llm/rtasr_llm.html
 */
export function xfyunLlmUrl(cfg, lang, now = Date.now(), uuid = crypto.randomUUID()) {
  const params = {
    accessKeyId: cfg.apiKey,
    appId: cfg.appId,
    audio_encode: 'pcm_s16le',
    lang: 'autodialect', // 中英 + dialects, auto-detected — right for a zh/en family call
    samplerate: '16000',
    utc: xfyunUtc(now),
    uuid,
  };
  const base = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  const signature = crypto.createHmac('sha1', cfg.apiSecret).update(base).digest('base64');
  return `${cfg.llmUrl}?${base}&signature=${encodeURIComponent(signature)}`;
}

/** Which xfyun endpoint to speak: the 大模型版 when an APISecret exists, else classic. */
export function xfyunService(cfg) {
  if (cfg.service && cfg.service !== 'auto') return cfg.service;
  return cfg.apiSecret ? 'rtasr_llm' : 'rtasr';
}

const FRAME_BYTES = 1280; // RTASR wants small binary frames (≈40 ms of 16 kHz int16)

/**
 * iFlytek (xfyun.cn) 实时语音转写: continuous streaming transcription.
 * With an APISecret set it speaks the 大模型版 (new_rta, what new accounts get);
 * otherwise the classic RTASR at rtasr.xfyun.cn.
 * Docs: https://www.xfyun.cn/doc/asr/rtasr/API.html
 */
export class XfyunTranscriber extends WsTranscriber {
  static audioRate = 16000;
  static autoLang = true;

  constructor(opts) {
    super(opts);
    this.cfg = opts.cfg.xfyun;
    this.utt = 0; // RTASR interims carry the whole current sentence; we key them per utterance
    this.sessionId = null;
  }

  _open() {
    if (!this.cfg.appId || !this.cfg.apiKey) throw new Error('XFYUN_APP_ID / XFYUN_API_KEY is not set');
    const url = xfyunService(this.cfg) === 'rtasr_llm'
      ? xfyunLlmUrl(this.cfg, this.lang)
      : xfyunUrl(this.cfg, this.lang);
    return new WebSocket(url);
  }

  _onOpen() {
    // No session config frame: RTASR starts on connection and answers {action:"started"}.
  }

  _sendAudio(buf) {
    for (let o = 0; o < buf.length; o += FRAME_BYTES) this.ws.send(buf.subarray(o, o + FRAME_BYTES));
  }

  _onMessage(msg) {
    // 大模型版 envelope: {msg_type:'action'|'result', data:{...}} with data as an object.
    if (msg.msg_type) {
      const d = msg.data || {};
      if (msg.msg_type === 'action') {
        if (d.action === 'started') {
          this.sessionId = d.sessionId || null;
          this.opts.onStatus?.(true, 'ok');
        } else if (d.action === 'error' || d.code) {
          this.log?.error('xfyun error:', JSON.stringify(d).slice(0, 300));
          this.opts.onStatus?.(false, d.desc || d.message || `error ${d.code || ''}`);
        }
      } else if (msg.msg_type === 'result') {
        this._onResult(d);
      } else if (msg.msg_type === 'error') {
        this.log?.error('xfyun error:', JSON.stringify(msg).slice(0, 300));
        this.opts.onStatus?.(false, d.desc || 'error');
      }
      return;
    }
    // Classic RTASR envelope: {action, code, desc, data:"<json string>"}.
    switch (msg.action) {
      case 'started':
        this.sessionId = msg.sessionId || msg.sid || null;
        this.opts.onStatus?.(true, 'ok');
        break;
      case 'error':
        this.log?.error('xfyun error:', msg.code, msg.desc);
        this.opts.onStatus?.(false, msg.desc || `error ${msg.code}`);
        break;
      case 'result': {
        let d;
        try { d = JSON.parse(msg.data); } catch { return; }
        this._onResult(d);
        break;
      }
      default:
        break;
    }
  }

  _onResult(d) {
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
  }

  _beforeClose() {
    const end = this.sessionId ? { end: true, sessionId: this.sessionId } : { end: true };
    try { this.ws.send(JSON.stringify(end)); } catch { /* ignore */ }
  }
}
