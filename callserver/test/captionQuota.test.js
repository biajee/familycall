import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameSeconds, meterFrame } from '../server/captionQuota.js';

test('frameSeconds: int16 mono PCM is 2 bytes per sample', () => {
  assert.equal(frameSeconds(32000, 16000), 1);
  assert.equal(frameSeconds(48000, 24000), 1);
  assert.equal(frameSeconds(3200, 16000), 0.1);
});

test('meterFrame: null/undefined allowance is unlimited and stays unlimited', () => {
  assert.deepEqual(meterFrame(null, 5), { allowed: true, remaining: null });
  assert.deepEqual(meterFrame(undefined, 5), { allowed: true, remaining: null });
});

test('meterFrame: spends the allowance frame by frame', () => {
  assert.deepEqual(meterFrame(10, 1), { allowed: true, remaining: 9 });
  assert.deepEqual(meterFrame(1, 0.5), { allowed: true, remaining: 0.5 });
});

test('meterFrame: the frame that crosses zero is allowed, then clamps to 0 and the next is refused', () => {
  assert.deepEqual(meterFrame(0.5, 1), { allowed: true, remaining: 0 });
  assert.deepEqual(meterFrame(0, 1), { allowed: false, remaining: 0 });
});

test('meterFrame: a negative allowance is treated as spent, never as credit', () => {
  assert.deepEqual(meterFrame(-3, 1), { allowed: false, remaining: 0 });
});

test('meterFrame: an allowance of exactly 0 (a free plan that has used it all) refuses immediately', () => {
  assert.equal(meterFrame(0, 0.1).allowed, false);
});
