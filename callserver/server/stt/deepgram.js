import WebSocket from 'ws';
import { WsTranscriber } from './base.js';

/** App language -> Deepgram `language` parameter. Deepgram's `multi` mode has no Mandarin. */
export function deepgramLanguage(lang) {
  if (lang === 'auto') return 'zh-CN';
  return lang;
}

/**
 * Deepgram live streaming. Docs: https://developers.deepgram.com/reference/speech-to-text-api/listen-streaming
 */
export class DeepgramTranscriber extends WsTranscriber {
  static audioRate = 16000;
  static autoLang = false;

  constructor(opts) {
    super(opts);
    this.cfg = opts.cfg.deepgram;
    this.utt = 0;
    this.finalized = '';
    this.keepalive = null;
    this.sep = this.lang.startsWith('zh') ? '' : ' ';
  }

  _open() {
    if (!this.cfg.apiKey) throw new Error('DEEPGRAM_API_KEY is not set');
    const params = new URLSearchParams({
      model: this.cfg.model,
      language: deepgramLanguage(this.lang),
      encoding: 'linear16',
      sample_rate: String(DeepgramTranscriber.audioRate),
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      endpointing: '300',
      utterance_end_ms: '1200',
    });
    return new WebSocket(`${this.cfg.url}?${params}`, {
      headers: { Authorization: `Token ${this.cfg.apiKey}` },
    });
  }

  _onOpen() {
    this.opts.onStatus?.(true, 'ok');
    clearInterval(this.keepalive);
    // Deepgram closes the stream after ~10 s without data; keep it alive while the mic is muted.
    this.keepalive = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastAudioAt > 4000) {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 4000);
  }

  _sendAudio(buf) {
    this.ws.send(buf);
  }

  _join(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a + this.sep + b;
  }

  _emit(final, interim = '') {
    const text = this._join(this.finalized, interim);
    if (text) this.emit({ key: `u${this.utt}`, text, final });
  }

  _finish() {
    if (!this.finalized) return;
    this._emit(true);
    this.utt++;
    this.finalized = '';
  }

  _onMessage(msg) {
    if (msg.type === 'Results') {
      const t = (msg.channel?.alternatives?.[0]?.transcript || '').trim();
      if (msg.is_final) {
        if (t) this.finalized = this._join(this.finalized, t);
        if (msg.speech_final) this._finish();
        else if (t) this._emit(false);
      } else if (t) {
        this._emit(false, t);
      }
    } else if (msg.type === 'UtteranceEnd') {
      this._finish();
    } else if (msg.type === 'Error' || msg.type === 'error') {
      this.log?.error('deepgram error:', msg.description || msg.message || JSON.stringify(msg));
      this.opts.onStatus?.(false, msg.description || 'error');
    }
  }

  _beforeClose() {
    this.ws.send(JSON.stringify({ type: 'CloseStream' }));
  }

  close() {
    clearInterval(this.keepalive);
    this._finish();
    super.close();
  }
}
