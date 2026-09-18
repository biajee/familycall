import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const RECENT_CALLS_LIMIT = 150;
const RECENT_LOGS_LIMIT = 200;
const RECENT_PAGEVIEWS_LIMIT = 150;

// Called server-to-server by zbackroom.com's /admin — same pattern as
// ConfirmPO's /api/internal/admin-data. The admin dashboard lives at
// zbackroom.com, not here; this route just exposes the underlying data.
export async function GET(req: NextRequest) {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "INTERNAL_API_SECRET not configured" }, { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const level = req.nextUrl.searchParams.get("level") || undefined;
  const validLevel = level && ["ERROR", "WARN", "INFO"].includes(level) ? level : undefined;

  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  const [accounts, totalAccounts, totalRooms, callsThisMonthAgg, captionAgg, recentCalls, logs, pageViews] =
    await Promise.all([
      prisma.account.findMany({
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { rooms: true } } },
      }),
      prisma.account.count(),
      prisma.room.count({ where: { deletedAt: null } }),
      prisma.callSession.aggregate({
        where: { createdAt: { gte: startOfMonth }, seconds: { not: null } },
        _count: true,
        _sum: { seconds: true },
      }),
      prisma.captionUsage.aggregate({
        where: { createdAt: { gte: startOfMonth } },
        _sum: { seconds: true },
      }),
      prisma.callSession.findMany({
        orderBy: { createdAt: "desc" },
        take: RECENT_CALLS_LIMIT,
        include: { room: { select: { label: true, slug: true, account: { select: { email: true } } } } },
      }),
      prisma.appLog.findMany({
        where: validLevel ? { level: validLevel } : undefined,
        orderBy: { createdAt: "desc" },
        take: RECENT_LOGS_LIMIT,
      }),
      prisma.pageView.findMany({ orderBy: { createdAt: "desc" }, take: RECENT_PAGEVIEWS_LIMIT }),
    ]);

  return NextResponse.json({
    app: "familycall",
    totalAccounts,
    totalRooms,
    callsThisMonth: callsThisMonthAgg._count,
    minutesThisMonth: Math.round((callsThisMonthAgg._sum.seconds ?? 0) / 60),
    captionMinutesThisMonth: Math.round((captionAgg._sum.seconds ?? 0) / 60),
    accounts: accounts.map((a) => ({
      email: a.email,
      plan: a.plan,
      planStatus: a.planStatus,
      roomCount: a._count.rooms,
      createdAt: a.createdAt,
    })),
    recentCalls: recentCalls.map((c) => ({
      createdAt: c.createdAt,
      accountEmail: c.room.account.email,
      roomLabel: c.room.label ?? c.room.slug,
      seconds: c.seconds,
    })),
    logs,
    pageViews,
  });
}
