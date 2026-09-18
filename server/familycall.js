/**
 * Integration with the FamilyCall shell app (a separate Next.js app,
 * familycall.zbackroom.com — account/billing/room management, its own
 * repo and deploy). This server never stores accounts or plans; it just
 * asks the shell whether a room may be joined, and tells it afterward how
 * long a finished call ran.
 *
 * Reliability posture (deliberate, see FamilyCall's SPEC.md "Call-server
 * integration contract"): fails OPEN (lets the call proceed) when the
 * shell isn't configured, unreachable, or errors — a brief outage of the
 * billing app must never be the reason a hard-of-hearing family member
 * can't reach their family. Fails CLOSED only on an explicit rejection
 * from the shell (room doesn't exist, or this month's quota is used up).
 */

const TIMEOUT_MS = 4000;

/** @returns {Promise<{ok: true, roomId?: string} | {ok: false, reason: string}>} */
export async function validateRoom(cfg, log, slug) {
  const { shellUrl, secret } = cfg.familycall;
  if (!shellUrl) return { ok: true }; // no shell configured — legacy/local single-family mode

  let res;
  try {
    res = await fetch(`${shellUrl}/api/internal/validate-room?slug=${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    log.warn(`familycall validate-room unreachable, failing open: ${err.message}`);
    return { ok: true };
  }

  if (res.status === 404) return { ok: false, reason: 'not_found' };
  if (!res.ok) {
    log.warn(`familycall validate-room returned ${res.status}, failing open`);
    return { ok: true };
  }

  try {
    const data = await res.json();
    if (data && data.ok === false) return { ok: false, reason: data.reason || 'rejected' };
    return { ok: true, roomId: data?.roomId };
  } catch (err) {
    log.warn(`familycall validate-room returned invalid JSON, failing open: ${err.message}`);
    return { ok: true };
  }
}

/** Fire-and-forget — callers must not await this on the hangup path. */
export function reportCallUsage(cfg, log, { slug, startedAt, endedAt, seconds }) {
  const { shellUrl, secret } = cfg.familycall;
  if (!shellUrl) return;

  fetch(`${shellUrl}/api/internal/call-usage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      slug,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      seconds,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then((res) => {
      if (!res.ok) log.warn(`familycall call-usage report rejected: ${res.status}`);
    })
    .catch((err) => log.warn(`familycall call-usage report failed: ${err.message}`));
}
