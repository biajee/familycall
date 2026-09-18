/**
 * Bookkeeping for a room's live-caption allowance. Pure logic, no I/O, so it
 * is unit-testable (same convention as rooms.js).
 *
 * Calls are never limited, only captions: the FamilyCall shell tells us on
 * the first join of a room how many seconds of speech-to-text the room
 * owner's plan has left this month (null = unlimited), and every audio
 * frame that would be sent to the STT provider is metered against it.
 */

/** Duration of an int16 mono PCM frame. */
export function frameSeconds(byteLength, audioRate) {
  return byteLength / 2 / audioRate;
}

/**
 * @param remaining seconds left, or null/undefined for unlimited
 * @param seconds   duration of the frame about to be transcribed
 * @returns {{allowed: boolean, remaining: number|null}}
 *
 * The frame that takes the allowance to zero is still allowed (frames are
 * at most a couple of seconds long, so the overshoot is bounded and it
 * avoids dropping half a sentence); the next one is refused.
 */
export function meterFrame(remaining, seconds) {
  if (remaining === null || remaining === undefined) return { allowed: true, remaining: null };
  if (remaining <= 0) return { allowed: false, remaining: 0 };
  return { allowed: true, remaining: Math.max(0, remaining - seconds) };
}
