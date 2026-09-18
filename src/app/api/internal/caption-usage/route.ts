import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";

// Called server-to-server by the call server when a phone leaves a room —
// reports how many seconds of audio that phone sent to the speech-to-text
// provider (see callserver/server/app.js). This is the usage plan limits
// are enforced against. Best-effort on both sides, like call-usage: the
// call server fires it without awaiting it, and an unknown room just acks
// 200 (logged) rather than erroring — a usage report must never be the
// reason someone couldn't hang up cleanly.
export async function POST(req: NextRequest) {
  const secret = process.env.FAMILYCALL_INTERNAL_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "FAMILYCALL_INTERNAL_SECRET not configured" }, { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const slug = body?.slug ? String(body.slug) : null;
  const seconds = Number(body?.seconds);
  if (!slug || !Number.isFinite(seconds) || seconds <= 0) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const room = await prisma.room.findFirst({ where: { slug } });
  if (!room) {
    await log("WARN", "call-server", "caption-usage reported for unknown room", { slug });
    return NextResponse.json({ ok: true });
  }

  await prisma.captionUsage.create({ data: { roomId: room.id, seconds: Math.round(seconds) } });

  return NextResponse.json({ ok: true });
}
