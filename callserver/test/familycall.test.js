import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRoom, reportCallUsage, reportCaptionUsage } from '../server/familycall.js';

const log = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} };
const withShell = { familycall: { shellUrl: 'https://shell.example', secret: 's' } };
const noShell = { familycall: { shellUrl: '', secret: '' } };

function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

const json = (status, body) => () => Promise.resolve({ status, ok: status < 400, json: async () => body });

test('validateRoom: no shell configured -> ok and unmetered (legacy/local mode), never calls fetch', async () => {
  await withFetch(() => { throw new Error('fetch should not be called'); }, async () => {
    const r = await validateRoom(noShell, log, 'some-room');
    assert.deepEqual(r, { ok: true, captionSecondsRemaining: null });
  });
});

test('validateRoom: network error -> fails open, unmetered', async () => {
  await withFetch(() => Promise.reject(new Error('ECONNREFUSED')), async () => {
    const r = await validateRoom(withShell, log, 'some-room');
    assert.deepEqual(r, { ok: true, captionSecondsRemaining: null });
  });
});

test('validateRoom: 404 -> fails closed with not_found', async () => {
  await withFetch(json(404, { error: 'Not found' }), async () => {
    const r = await validateRoom(withShell, log, 'some-room');
    assert.deepEqual(r, { ok: false, reason: 'not_found' });
  });
});

test('validateRoom: passes the caption allowance and roomId through', async () => {
  await withFetch(json(200, { ok: true, roomId: 'r1', captionSecondsRemaining: 300 }), async () => {
    const r = await validateRoom(withShell, log, 'some-room');
    assert.deepEqual(r, { ok: true, roomId: 'r1', captionSecondsRemaining: 300 });
  });
});

test('validateRoom: an exhausted allowance (0) is still ok - calls are never blocked', async () => {
  await withFetch(json(200, { ok: true, roomId: 'r1', captionSecondsRemaining: 0 }), async () => {
    const r = await validateRoom(withShell, log, 'some-room');
    assert.equal(r.ok, true);
    assert.equal(r.captionSecondsRemaining, 0);
  });
});

test('validateRoom: null allowance means unlimited; a missing or non-numeric one is treated the same', async () => {
  for (const body of [{ ok: true, captionSecondsRemaining: null }, { ok: true }, { ok: true, captionSecondsRemaining: 'lots' }]) {
    await withFetch(json(200, body), async () => {
      const r = await validateRoom(withShell, log, 'some-room');
      assert.equal(r.ok, true);
      assert.equal(r.captionSecondsRemaining, null);
    });
  }
});

test('validateRoom: unexpected 500 -> fails open, does not throw', async () => {
  await withFetch(json(500, {}), async () => {
    const r = await validateRoom(withShell, log, 'some-room');
    assert.deepEqual(r, { ok: true, captionSecondsRemaining: null });
  });
});

test('reports: no shell configured -> never call fetch', async () => {
  await withFetch(() => { throw new Error('fetch should not be called'); }, () => {
    reportCallUsage(noShell, log, { slug: 'r', startedAt: new Date(), endedAt: new Date(), seconds: 60 });
    reportCaptionUsage(noShell, log, { slug: 'r', seconds: 60 });
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
      // Fire-and-forget by design: callers never await this on the hangup path.
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
  assert.deepEqual(JSON.parse(captured.opts.body), {
    slug: 'r1',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:05:00.000Z',
    seconds: 300,
  });
});

test('reportCaptionUsage: posts slug + seconds with the bearer secret and never throws on failure', async () => {
  const cfg = { familycall: { shellUrl: 'https://shell.example', secret: 'topsecret' } };
  let captured;
  await withFetch(
    (url, opts) => {
      captured = { url, opts };
      return Promise.reject(new Error('shell is down'));
    },
    () => reportCaptionUsage(cfg, log, { slug: 'r1', seconds: 42 }),
  );
  assert.equal(captured.url, 'https://shell.example/api/internal/caption-usage');
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers.Authorization, 'Bearer topsecret');
  assert.deepEqual(JSON.parse(captured.opts.body), { slug: 'r1', seconds: 42 });
});
