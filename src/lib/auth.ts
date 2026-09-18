import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";

// Must match zbackroom.com's SESSION_COOKIE constant exactly — FamilyCall
// never issues this cookie itself, it only reads the shared one zbackroom
// sets on the parent domain (.zbackroom.com). Same contract ConfirmPO uses.
const SESSION_COOKIE = "zbackroom_session";

function zbackroomUrl(): string {
  return process.env.ZBACKROOM_URL || "https://zbackroom.com";
}

function appUrl(): string {
  return process.env.APP_URL || "http://localhost:3002";
}

// `next` is a path within FamilyCall (e.g. "/app") — turned into an
// absolute URL since zbackroom.com's own redirect defaults are relative to
// ITS domain, not ours.
export function zbackroomLoginUrl(next: string): string {
  return `${zbackroomUrl()}/login?next=${encodeURIComponent(`${appUrl()}${next}`)}`;
}

export function zbackroomSignupUrl(next: string): string {
  return `${zbackroomUrl()}/signup?next=${encodeURIComponent(`${appUrl()}${next}`)}`;
}

export function zbackroomAccountUrl(): string {
  return `${zbackroomUrl()}/account`;
}

export function zbackroomLogoutUrl(next: string): string {
  return `${zbackroomUrl()}/api/auth/logout?next=${encodeURIComponent(`${appUrl()}${next}`)}`;
}

// Billing lives at zbackroom.com — one subscription across every app.
export function zbackroomBillingUrl(): string {
  return `${zbackroomUrl()}/account/billing`;
}

type IdentityResponse = { id: string; email: string; plan?: string; planStatus?: string | null };

function accountUpsertData(data: IdentityResponse) {
  return {
    email: data.email,
    plan: data.plan ?? "FREE",
    planStatus: data.planStatus ?? null,
  };
}

// Resolves the shared cookie into a user by asking zbackroom.com — that's
// the one app that owns sessions now. Keeps a local Account row in sync
// (id/email/plan) so FamilyCall-specific data (rooms, usage) stays
// attached to the right person across visits. One network call per check;
// fine at this traffic level, worth caching later if that changes.
export async function getCurrentUser() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return null;

  let res: Response;
  try {
    res = await fetch(
      `${zbackroomUrl()}/api/internal/validate-session?token=${encodeURIComponent(token)}`,
      { headers: { Authorization: `Bearer ${secret}` }, cache: "no-store" },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const data = (await res.json()) as IdentityResponse;
  if (!data?.id || !data?.email) return null;

  return prisma.account.upsert({
    where: { id: data.id },
    update: accountUpsertData(data),
    create: { id: data.id, ...accountUpsertData(data) },
  });
}

export async function isAuthenticated(): Promise<boolean> {
  return (await getCurrentUser()) !== null;
}
