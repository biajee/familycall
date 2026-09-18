import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRoom, reportCallUsage } from '../server/familycall.js';

const log = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} };

function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

test('validateRoom: no shell configured -> ok (legacy/local mode), never calls fetch', async () => {
  const cfg = { familycall: { shellUrl: '', secret: '' } };
  await withFetch(() => { throw new Error('fetch should not be called'); }, async () => {
    const r = await validateRoom(cfg, log, 'some-room');
    assert.deepEqual(r, { ok: true });
  });
});

test('validateRoom: network error -> fails open', async () => {
  const cfg = { familycall: { shellUrl: 'https://shell.example', secret: 's' } };
  await withFetch(() => Promise.reject(new Error('ECONNREFUSED')), async () => {
    const r = await validateRoom(cfg, log, 'some-room');
    assert.equal(r.ok, true);
  });
});

test('validateRoom: 404 -> fails closed with not_found', async () => {
  const cfg = { familycall: { shellUrl: 'https://shell.example', secret: 's' } };
  await withFetch(() => Promise.resolve({ status: 404, ok: false }), async () => {
    const r = await validateRoom(cfg, log, 'some-room');
    assert.deepEqual(r, { ok: false, reason: 'not_found' });
  });
});

test('validateRoom: 200 { ok:false, reason } -> fails closed with that reason', async () => {
  const cfg = { familycall: { shellUrl: 'https://shell.example', secret: 's' } };
  await withFetch(
    () => Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: false, reason: 'quota_exceeded' }) }),
    async () => {
      const r = await validateRoom(cfg, log, 'some-room');
      assert.deepEqual(r, { ok: false, reason: 'quota_exceeded' });
    },
  );
});

test('validateRoom: 200 { ok:true, roomId } -> ok, passes roomId through', async () => {
  const cfg = { familycall: { shellUrl: 'https://shell.example', secret: 's' } };
  await withFetch(
    () => Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true, roomId: 'r1' }) }),
    async () => {
      const r = await validateRoom(cfg, log, 'some-room');
      assert.deepEqual(r, { ok: true, roomId: 'r1' });
    },
  );
});

test('validateRoom: unexpected 500 -> fails open, does not throw', async () => {
  const cfg = { familycall: { shellUrl: 'https://shell.example', secret: 's' } };
  await withFetch(() => Promise.resolve({ status: 500, ok: false }), async () => {
    const r = await validateRoom(cfg, log, 'some-room');
    assert.equal(r.ok, true);
  });
});

test('reportCallUsage: no shell configured -> never calls fetch', async () => {
  const cfg = { familycall: { shellUrl: '', secret: '' } };
  await withFetch(() => { throw new Error('fetch should not be called'); }, () => {
    reportCallUsage(cfg, log, { slug: 'r', startedAt: new Date(), endedAt: new Date(), seconds: 60 });
  });
});

test('reportCallUsage: posts the expected body and never throws on failure', async () => {
  const cfg = { familycall: { shellUrl: 'https://shell.example', secret: 'topsecret' } };
  let captured;
  await withFetch(
    (url, opts) => {
      captured = { url, opts };
      return Promise.reject(new Error('shell is down'));
    },
    () => {
      // Fire-and-forget by design — callers never await this on the hangup path.
      reportCallUsage(cfg, log, {
        slug: 'r1',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        endedAt: new Date('2026-01-01T00:05:00Z'),
        seconds: 300,
      });
    },
  );
  assert.equal(captured.url, 'https://shell.example/api/internal/call-usage');
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers.Authorization, 'Bearer topsecret');
  const body = JSON.parse(captured.opts.body);
  assert.deepEqual(body, {
    slug: 'r1',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:05:00.000Z',
    seconds: 300,
  });
});
