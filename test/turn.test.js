import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { turnCredentials, buildIceServers } from '../server/turn.js';

test('TURN REST credentials follow the coturn use-auth-secret scheme', () => {
  const now = 1_700_000_000_000;
  const { username, credential } = turnCredentials('s3cret', 3600, 'abc', now);
  assert.equal(username, `${1_700_000_000 + 3600}:abc`);
  assert.equal(credential, createHmac('sha1', 's3cret').update(username).digest('base64'));
});

test('buildIceServers assembles STUN + TURN entries', () => {
  const cfg = {
    stunUrls: ['stun:example.com:3478'],
    turnUrls: ['turn:example.com:3478?transport=udp', 'turns:example.com:5349?transport=tcp'],
    turnSecret: 'k', turnTtlSec: 60, turnUser: '', turnPass: '',
  };
  const servers = buildIceServers(cfg, 'peer1');
  assert.equal(servers.length, 2);
  assert.deepEqual(servers[0], { urls: ['stun:example.com:3478'] });
  assert.equal(servers[1].urls.length, 2);
  assert.match(servers[1].username, /^\d+:peer1$/);
  assert.ok(servers[1].credential.length > 10);

  const staticCfg = { ...cfg, turnSecret: '', turnUser: 'u', turnPass: 'p' };
  assert.deepEqual(buildIceServers(staticCfg, 'x')[1], { urls: cfg.turnUrls, username: 'u', credential: 'p' });

  assert.deepEqual(buildIceServers({ ...cfg, stunUrls: [], turnUrls: [] }, 'x'), []);
});
