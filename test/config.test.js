import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDotEnv } from '../server/config.js';

test('.env loader strips inline comments and handles quotes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envtest-'));
  const path = join(dir, '.env');
  writeFileSync(path, [
    '# full-line comment',
    'T_HOST=127.0.0.1          # bind address (keep 127.0.0.1 behind Caddy)',
    'T_SECRET=abc#def',
    'T_QUOTED="hello # world"  # trailing note',
    "T_SINGLE='x y'",
    'T_EMPTY=',
    'T_EXISTING=from-file',
  ].join('\n'));
  process.env.T_EXISTING = 'from-env';
  try {
    loadDotEnv(path);
    assert.equal(process.env.T_HOST, '127.0.0.1');
    assert.equal(process.env.T_SECRET, 'abc#def', 'a # inside a value without spaces is kept');
    assert.equal(process.env.T_QUOTED, 'hello # world');
    assert.equal(process.env.T_SINGLE, 'x y');
    assert.equal(process.env.T_EMPTY, '');
    assert.equal(process.env.T_EXISTING, 'from-env', 'existing env vars win');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const k of ['T_HOST', 'T_SECRET', 'T_QUOTED', 'T_SINGLE', 'T_EMPTY', 'T_EXISTING']) delete process.env[k];
  }
});
