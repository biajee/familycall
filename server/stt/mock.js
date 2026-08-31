/**
 * Fake transcriber for development and tests. Emits an interim caption after
 * 0.5 s of audio and a final caption after 2 s, no network required.
 */
export class MockTranscriber {
  static audioRate = 16000;
  static autoLang = true;

  constructor(opts) {
    this.opts = opts;
    this.lang = opts.lang;
    this.bytes = 0;
    this.n = 0;
    this.closed = false;
    this.interimSent = false;
  }

  start() {
    this.opts.onStatus?.(true, 'mock');
    return this;
  }

  _text(final) {
    const zh = this.lang.startsWith('zh');
    const base = zh ? `这是测试字幕 ${this.n + 1}` : `This is a test caption ${this.n + 1}`;
    return final ? base + (zh ? '。' : '.') : base.slice(0, Math.ceil(base.length / 2));
  }

  write(buf) {
    if (this.closed) return;
    this.bytes += buf.length;
    const bytesPerSec = MockTranscriber.audioRate * 2;
    if (!this.interimSent && this.bytes >= bytesPerSec * 0.5) {
      this.interimSent = true;
      this.opts.onText?.({ key: `m${this.n}`, text: this._text(false), final: false });
    }
    if (this.bytes >= bytesPerSec * 2) {
      this.opts.onText?.({ key: `m${this.n}`, text: this._text(true), final: true });
      this.n++;
      this.bytes = 0;
      this.interimSent = false;
    }
  }

  close() {
    this.closed = true;
  }
}
