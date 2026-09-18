import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { minutesRemaining } from "@/lib/plan";

// Called server-to-server by the call server (a separate app, on its own
// VPS — see stt_videocall/server/familycall.js) before letting a peer join
// a room. Bearer-secret pattern, same as every other internal endpoint in
// the suite, but a DIFFERENT secret from zbackroom/ConfirmPO's
// INTERNAL_API_SECRET — the call server accepts arbitrary inbound
// WebSocket connections from the open internet, a materially bigger
// attack surface, so it shouldn't hold a secret that also protects
// zbackroom's validate-session/admin-data.
//
// 404 means "no such room" (call server should reject the join outright).
// 200 with ok:false means the room IS real but this month's plan quota is
// used up — a different, friendlier message than "room not found".
export async function GET(req: NextRequest) {
  const secret = process.env.FAMILYCALL_INTERNAL_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "FAMILYCALL_INTERNAL_SECRET not configured" }, { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const slug = req.nextUrl.searchParams.get("slug");
  if (!slug) {
    return NextResponse.json({ error: "Missing slug" }, { status: 400 });
  }

  const room = await prisma.room.findFirst({
    where: { slug, deletedAt: null },
    include: { account: true, participants: true },
  });
  if (!room) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const remaining = await minutesRemaining(room.account);
  if (remaining !== null && remaining <= 0) {
    return NextResponse.json({ ok: false, reason: "quota_exceeded" });
  }

  return NextResponse.json({
    ok: true,
    roomId: room.id,
    participants: room.participants.map((p) => ({
      slot: p.slot,
      name: p.name,
      lang: p.lang,
    })),
  });
}
