import webpush from 'web-push';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Web Push "ringing": phones that opted in (开启来电提醒) get a push notification
 * when someone starts a call in their room. Subscriptions are kept per room and
 * device in a JSON file so they survive restarts.
 */
export function createPush(cfg, log) {
  const enabled = !!(cfg.vapid.publicKey && cfg.vapid.privateKey);
  if (enabled) webpush.setVapidDetails(cfg.vapid.subject, cfg.vapid.publicKey, cfg.vapid.privateKey);
  const file = join(cfg.dataDir, 'push-subscriptions.json');
  let subs = {};
  try { subs = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { /* first run */ }
  const save = () => {
    try {
      mkdirSync(cfg.dataDir, { recursive: true });
      writeFileSync(file, JSON.stringify(subs));
    } catch (err) {
      log?.warn('cannot save push subscriptions:', err.message);
    }
  };

  return {
    enabled,
    publicKey: cfg.vapid.publicKey || '',
    subscribe(room, device, name, subscription) {
      (subs[room] ||= {})[device] = { name, subscription, ts: Date.now() };
      save();
    },
    unsubscribe(room, device) {
      if (subs[room]?.[device]) { delete subs[room][device]; save(); }
    },
    count(room) {
      return Object.keys(subs[room] || {}).length;
    },
    /** Push `payload` to every subscribed device in the room except the caller's. Resolves to the number sent. */
    async notifyRoom(room, payload, exceptDevice) {
      if (!enabled) return 0;
      const entries = Object.entries(subs[room] || {}).filter(([device]) => device !== exceptDevice);
      let sent = 0;
      await Promise.all(entries.map(async ([device, rec]) => {
        try {
          await webpush.sendNotification(rec.subscription, JSON.stringify(payload), { TTL: 60, urgency: 'high' });
          sent++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            delete subs[room][device]; // expired subscription
            save();
          } else {
            log?.warn(`push to ${device} failed:`, err.statusCode || err.message);
          }
        }
      }));
      return sent;
    },
  };
}
