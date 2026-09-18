import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";

// Called server-to-server by the call server when a room's peer count
// drops back below 2 (see stt_videocall/server/app.js) — reports how long
// the call that just ended actually ran. Best-effort on both sides: the
// call server fires this without awaiting it on the hangup path, and a
// lookup miss here just acks 200 rather than erroring — a usage-reporting
// failure must never be the reason a call couldn't end cleanly.
export async function POST(req: NextRequest) {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "INTERNAL_API_SECRET not configured" }, { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const slug = body?.slug ? String(body.slug) : null;
  const seconds = Number(body?.seconds);
  if (!slug || !Number.isFinite(seconds) || seconds < 0) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const room = await prisma.room.findFirst({ where: { slug, deletedAt: null } });
  if (!room) {
    await log("WARN", "call-server", "call-usage reported for unknown room", { slug });
    return NextResponse.json({ ok: true }); // ack anyway — see comment above
  }

  const startedAt = body.startedAt ? new Date(body.startedAt) : new Date(Date.now() - seconds * 1000);
  const endedAt = body.endedAt ? new Date(body.endedAt) : new Date();

  await prisma.callSession.create({
    data: { roomId: room.id, startedAt, endedAt, seconds: Math.round(seconds) },
  });

  return NextResponse.json({ ok: true });
}
