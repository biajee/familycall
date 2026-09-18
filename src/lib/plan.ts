import { prisma } from "@/lib/prisma";

// What each plan gets. Calls are UNLIMITED on every plan — the metered,
// cost-driving resource is live captions (audio sent to the speech-to-text
// provider), so that's what plans differ on, along with how many rooms
// (family pairings) an account may have. `null` means unlimited.
//
// This one table drives both limit enforcement and the pricing shown on the
// marketing page, so they can't drift apart. Prices are also configured in
// zbackroom (lib/plan.ts's APPS catalog for what the checkout displays, and
// deploy/setup-square-familycall-catalog.js for what Square charges) — if
// you change a price, change it in all three. The numbers are placeholders
// worth revisiting once real STT costs and usage are known.
export type PlanId = "FREE" | "FAMILY" | "FAMILY_PLUS";

export type PlanDef = {
  label: string;
  priceCents: number;
  roomLimit: number | null;
  captionMinutes: number | null;
};

export const PLANS: Record<PlanId, PlanDef> = {
  FREE: { label: "Free", priceCents: 0, roomLimit: 1, captionMinutes: 5 },
  FAMILY: { label: "Family", priceCents: 500, roomLimit: 2, captionMinutes: 120 },
  FAMILY_PLUS: { label: "Family Plus", priceCents: 1200, roomLimit: 5, captionMinutes: 600 },
};

export const PLAN_ORDER: PlanId[] = ["FREE", "FAMILY", "FAMILY_PLUS"];

// `?? fallback` would be the wrong tool for the limits inside a plan —
// `null` means "unlimited" on purpose, but `??` treats any `null` as
// "missing" and would silently substitute the fallback (this exact bug
// happened once in ConfirmPO — see its SPEC.md). No plan is unlimited
// today, but the type allows it, so keep reading limits through here: it
// only falls back for a plan value that isn't a key at all (for instance
// an app-level plan name zbackroom adds later).
export function planDef(plan: string): PlanDef {
  return plan in PLANS ? PLANS[plan as PlanId] : PLANS.FREE;
}

export function planLabel(plan: string): string {
  return planDef(plan).label;
}

export function formatPrice(priceCents: number): string {
  if (priceCents === 0) return "$0";
  const dollars = priceCents / 100;
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}/mo`;
}

// 90 seconds -> "1.5", 120 -> "2". Whole minutes hide too much when the free
// plan's whole allowance is 5.
export function formatMinutes(seconds: number): string {
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
}

export async function assertUnderRoomLimit(user: { id: string; plan: string }): Promise<void> {
  const limit = planDef(user.plan).roomLimit;
  if (limit === null) return;

  const count = await prisma.room.count({ where: { accountId: user.id, deletedAt: null } });
  if (count >= limit) {
    throw new Error(
      `You've reached your ${planLabel(user.plan)} plan's room limit (${limit}). Upgrade to create more.`,
    );
  }
}

// Caption seconds this account's rooms have used this calendar month.
export async function captionSecondsUsedThisMonth(accountId: string): Promise<number> {
  const since = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const agg = await prisma.captionUsage.aggregate({
    where: { room: { accountId }, createdAt: { gte: since } },
    _sum: { seconds: true },
  });
  return agg._sum.seconds ?? 0;
}

// Seconds of live captions left this month, or null if the plan is
// unlimited. Handed to the call server on every room join.
export async function captionSecondsRemaining(user: { id: string; plan: string }): Promise<number | null> {
  const minutes = planDef(user.plan).captionMinutes;
  if (minutes === null) return null;
  const used = await captionSecondsUsedThisMonth(user.id);
  return Math.max(0, minutes * 60 - used);
}
