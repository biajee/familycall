import WebSocket from 'ws';
import { WsTranscriber } from './base.js';

/**
 * Self-hosted FunASR (Alibaba DAMO, open source) via its WebSocket server in
 * "2pass" mode: streaming Paraformer partials, then an offline Paraformer +
 * punctuation pass per VAD segment that replaces them.
 * Protocol: https://github.com/modelscope/FunASR/blob/main/runtime/docs/websocket_protocol.md
 */
export class FunasrTranscriber extends WsTranscriber {
  static audioRate = 16000;
  static autoLang = true; // paraformer-zh: Mandarin with embedded English words

  constructor(opts) {
    super(opts);
    this.cfg = opts.cfg.funasr;
    this.hotwords = opts.cfg.sttHotwords || '';
    this.utt = 0;
    this.online = ''; // streaming pieces accumulated since the last offline result
  }

  _open() {
    if (!this.cfg.url) throw new Error('FUNASR_URL is not set');
    // The FunASR server is started with subprotocols=["binary"] and rejects
    // handshakes that do not offer it ("missing subprotocol").
    return new WebSocket(this.cfg.url, ['binary']);
  }

  _onOpen() {
    this.online = '';
    const hello = {
      mode: '2pass',
      chunk_size: [5, 10, 5], // 600 ms chunks with 300 ms look-back / look-ahead
      chunk_interval: 10,
      encoder_chunk_look_back: 4,
      decoder_chunk_look_back: 0,
      wav_name: 'familycall',
      wav_format: 'pcm',
      audio_fs: FunasrTranscriber.audioRate,
      is_speaking: true,
      itn: true,
    };
    if (this.hotwords) hello.hotwords = this.hotwords;
    this.ws.send(JSON.stringify(hello));
    this.opts.onStatus?.(true, 'ok');
  }

  _sendAudio(buf) {
    this.ws.send(buf);
  }

  _onMessage(msg) {
    const text = String(msg.text || '').trim();
    if (msg.mode === '2pass-offline' || msg.mode === 'offline') {
      // Corrected, punctuated sentence for the VAD segment just ended.
      const key = `u${this.utt++}`;
      this.online = '';
      this.emit({ key, text, final: true });
    } else if (msg.mode === '2pass-online' || msg.mode === 'online') {
      // Streaming pieces are incremental: append.
      this.online += text;
      this.emit({ key: `u${this.utt}`, text: this.online.trim(), final: false });
    }
  }

  _beforeClose() {
    try { this.ws.send(JSON.stringify({ is_speaking: false })); } catch { /* ignore */ }
  }
}
