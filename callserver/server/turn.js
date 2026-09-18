import { createHmac } from 'node:crypto';

/**
 * TURN REST API credentials (coturn `use-auth-secret`): username is "<expiry>:<label>",
 * password is base64(HMAC-SHA1(secret, username)).
 */
export function turnCredentials(secret, ttlSec, label = 'user', now = Date.now()) {
  const expiry = Math.floor(now / 1000) + ttlSec;
  const username = `${expiry}:${label}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

/** Builds the RTCIceServer[] list handed to a client on join. */
export function buildIceServers(cfg, label) {
  const servers = [];
  if (cfg.stunUrls.length) servers.push({ urls: cfg.stunUrls });
  if (cfg.turnUrls.length) {
    if (cfg.turnSecret) {
      servers.push({ urls: cfg.turnUrls, ...turnCredentials(cfg.turnSecret, cfg.turnTtlSec, label) });
    } else if (cfg.turnUser) {
      servers.push({ urls: cfg.turnUrls, username: cfg.turnUser, credential: cfg.turnPass });
    }
  }
  return servers;
}
