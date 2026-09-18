/**
 * Integration with the FamilyCall shell app (a separate Next.js app,
 * familycall.zbackroom.com — account/billing/room management, deployed
 * separately). This server never stores accounts or plans; it asks the
 * shell whether a room exists and how much live-caption time its owner has
 * left, and reports usage back.
 *
 * Calls are unlimited on every plan, so a join is only ever refused for a
 * room that doesn't exist. What plans limit is live captions: the shell
 * returns `captionSecondsRemaining` (null = unlimited) and app.js meters
 * against it (see captionQuota.js).
 *
 * Reliability posture (deliberate, see FamilyCall's SPEC.md "Call-server
 * integration contract"): fails OPEN when the shell isn't configured,
 * unreachable, or errors — the call proceeds and captions are simply
 * unmetered. A brief outage of the billing app must never be the reason a
 * hard-of-hearing family member can't reach their family. Fails CLOSED only
 * on an explicit 404 (the room doesn't exist).
 */

const TIMEOUT_MS = 4000;

/**
 * @returns {Promise<{ok: true, roomId?: string, captionSecondsRemaining: number|null}
 *                 | {ok: false, reason: string}>}
 */
export async function validateRoom(cfg, log, slug) {
  const { shellUrl, secret } = cfg.familycall;
  const unmetered = { ok: true, captionSecondsRemaining: null };
  if (!shellUrl) return unmetered; // no shell configured — legacy/local single-family mode

  let res;
  try {
    res = await fetch(`${shellUrl}/api/internal/validate-room?slug=${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    log.warn(`familycall validate-room unreachable, failing open: ${err.message}`);
    return unmetered;
  }

  if (res.status === 404) return { ok: false, reason: 'not_found' };
  if (!res.ok) {
    log.warn(`familycall validate-room returned ${res.status}, failing open`);
    return unmetered;
  }

  try {
    const data = await res.json();
    const remaining = data?.captionSecondsRemaining;
    return {
      ok: true,
      roomId: data?.roomId,
      captionSecondsRemaining: typeof remaining === 'number' ? remaining : null,
    };
  } catch (err) {
    log.warn(`familycall validate-room returned invalid JSON, failing open: ${err.message}`);
    return unmetered;
  }
}

/** Fire-and-forget: callers must never await these on the hangup path. */
function postUsage(cfg, log, path, body) {
  const { shellUrl, secret } = cfg.familycall;
  if (!shellUrl) return;

  fetch(`${shellUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then((res) => {
      if (!res.ok) log.warn(`familycall ${path} report rejected: ${res.status}`);
    })
    .catch((err) => log.warn(`familycall ${path} report failed: ${err.message}`));
}

/** How long a finished call ran (informational: shown in the shell, not enforced). */
export function reportCallUsage(cfg, log, { slug, startedAt, endedAt, seconds }) {
  postUsage(cfg, log, '/api/internal/call-usage', {
    slug,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    seconds,
  });
}

/** Seconds of audio one phone sent to speech-to-text: what plan limits are enforced against. */
export function reportCaptionUsage(cfg, log, { slug, seconds }) {
  postUsage(cfg, log, '/api/internal/caption-usage', { slug, seconds });
}
