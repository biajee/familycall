/**
 * Streaming linear-interpolation resampler (Float32 in, Float32 out).
 * Keeps the last input sample and the fractional read position between calls
 * so chunk boundaries do not produce glitches. Good enough for speech to STT.
 */
export class Resampler {
  constructor(inRate, outRate) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error('invalid sample rates');
    this.ratio = inRate / outRate;
    this.prev = 0;
    this.pos = 1; // virtual index: 0 = this.prev, k = input[k-1]
  }

  process(input) {
    const n = input.length;
    if (n === 0) return new Float32Array(0);
    if (this.ratio === 1) return Float32Array.from(input);
    const out = new Float32Array(Math.ceil((n + 1 - this.pos) / this.ratio) + 1);
    let count = 0;
    let pos = this.pos;
    while (pos + 1 <= n) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? this.prev : input[i - 1];
      const b = input[i];
      out[count++] = a + (b - a) * frac;
      pos += this.ratio;
    }
    this.prev = input[n - 1];
    this.pos = pos - n;
    return out.subarray(0, count);
  }
}

/** Float32 [-1,1] -> Int16 with clipping. */
export function floatToInt16(input, out = new Int16Array(input.length)) {
  for (let i = 0; i < input.length; i++) {
    const s = input[i];
    out[i] = s <= -1 ? -32768 : s >= 1 ? 32767 : s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}
