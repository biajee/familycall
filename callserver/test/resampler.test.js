import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resampler, floatToInt16 } from '../public/resampler.js';

function sine(rate, hz, seconds) {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

test('resampler output length matches the rate ratio across chunk boundaries', () => {
  const rs = new Resampler(48000, 16000);
  const input = sine(48000, 440, 1);
  let total = 0;
  for (let off = 0; off < input.length; off += 128) total += rs.process(input.subarray(off, off + 128)).length;
  assert.ok(Math.abs(total - 16000) <= 2, `expected ~16000 samples, got ${total}`);
});

test('resampled sine keeps its frequency', () => {
  const rs = new Resampler(44100, 24000);
  const out = rs.process(sine(44100, 200, 0.5));
  // 200 Hz over 0.5 s -> ~200 zero crossings
  let crossings = 0;
  for (let i = 1; i < out.length; i++) if ((out[i - 1] < 0) !== (out[i] < 0)) crossings++;
  assert.ok(Math.abs(crossings - 200) <= 2, `crossings=${crossings}`);
  assert.ok(Math.max(...out) > 0.95 && Math.min(...out) < -0.95);
});

test('identity ratio passes data through', () => {
  const rs = new Resampler(16000, 16000);
  const out = rs.process(Float32Array.from([0.1, 0.2, 0.3]));
  assert.deepEqual([...out], [0.1, 0.2, 0.3].map((v) => Math.fround(v)));
});

test('floatToInt16 clips and scales', () => {
  const out = floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
  assert.deepEqual([...out], [0, 32767, -32768, 32767, -32768, 16384]);
});
