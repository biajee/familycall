import { prisma } from "@/lib/prisma";

// How many rooms (family pairings) an account may create.
export const ROOM_LIMITS: Record<string, number | null> = {
  FREE: 1,
  STARTER: 5,
  BUSINESS: null, // unlimited
};

// Call minutes per calendar month — the cost-driving metric, since STT
// bills per minute of audio. Placeholder numbers: tune before real launch.
export const MINUTE_LIMITS: Record<string, number | null> = {
  FREE: 60,
  STARTER: 500,
  BUSINESS: null, // unlimited
};

// `?? fallback` is the wrong tool here — BUSINESS's `null` means
// "unlimited" on purpose, but `??` treats any `null` as "missing" and
// would silently replace it with the fallback, capping BUSINESS at the
// FREE limit (this exact bug happened once in ConfirmPO — see its
// SPEC.md). Only falls back for a plan value that isn't a key in the map
// at all.
function limitFor(map: Record<string, number | null>, plan: string): number | null {
  return plan in map ? map[plan] : map.FREE;
}

export async function assertUnderRoomLimit(user: { id: string; plan: string }): Promise<void> {
  const limit = limitFor(ROOM_LIMITS, user.plan);
  if (limit === null) return;

  const count = await prisma.room.count({ where: { accountId: user.id, deletedAt: null } });
  if (count >= limit) {
    throw new Error(
      `You've reached your ${user.plan} plan's room limit (${limit}). Upgrade at /account/billing to create more.`,
    );
  }
}

// Sums this month's reported call seconds for an account, across every
// room it owns. Used both to show "minutes used" on the dashboard and by
// /api/internal/validate-room to decide whether a new call may start.
export async function minutesUsedThisMonth(accountId: string): Promise<number> {
  const since = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const sessions = await prisma.callSession.findMany({
    where: { room: { accountId }, createdAt: { gte: since }, seconds: { not: null } },
    select: { seconds: true },
  });
  const totalSeconds = sessions.reduce((sum, s) => sum + (s.seconds ?? 0), 0);
  return Math.round(totalSeconds / 60);
}

export async function minutesRemaining(user: { id: string; plan: string }): Promise<number | null> {
  const limit = limitFor(MINUTE_LIMITS, user.plan);
  if (limit === null) return null;
  const used = await minutesUsedThisMonth(user.id);
  return Math.max(0, limit - used);
}
