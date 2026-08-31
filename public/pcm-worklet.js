import { Resampler } from './resampler.js';

/** Captures mono audio, resamples to `targetRate`, and posts int16 chunks of `chunkMs`. */
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { targetRate = 16000, chunkMs = 100 } = options.processorOptions || {};
    this.resampler = new Resampler(sampleRate, targetRate);
    this.chunk = Math.max(160, Math.round((targetRate * chunkMs) / 1000));
    this.buf = new Int16Array(this.chunk);
    this.len = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const out = this.resampler.process(ch);
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      this.buf[this.len++] = s <= -1 ? -32768 : s >= 1 ? 32767 : s < 0 ? (s * 32768) | 0 : (s * 32767) | 0;
      if (this.len === this.chunk) {
        const copy = this.buf.slice(0);
        this.port.postMessage(copy.buffer, [copy.buffer]);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
