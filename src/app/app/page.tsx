import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, zbackroomLoginUrl, zbackroomBillingUrl } from "@/lib/auth";
import { PLAN_ORDER, captionSecondsUsedThisMonth, formatMinutes, planDef } from "@/lib/plan";

function fmt(d: Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect(zbackroomLoginUrl("/app"));

  const [rooms, secondsUsed] = await Promise.all([
    prisma.room.findMany({
      where: { accountId: user.id, deletedAt: null },
      include: { participants: true },
      orderBy: { createdAt: "desc" },
    }),
    captionSecondsUsedThisMonth(user.id),
  ]);

  const captionMinutes = planDef(user.plan).captionMinutes;
  const isTopPlan = user.plan === PLAN_ORDER[PLAN_ORDER.length - 1];

  return (
    <main className="container">
      <div className="header-row">
        <h1>My Rooms</h1>
        <Link href="/rooms/new" className="button">
          + New room
        </Link>
      </div>

      <p className="muted" style={{ marginBottom: 24 }}>
        Calls are unlimited.{" "}
        {captionMinutes === null
          ? "Live captions are unlimited on your plan."
          : `${formatMinutes(secondsUsed)} of ${captionMinutes} live-caption minutes used this month.`}
        {!isTopPlan ? (
          <>
            {" "}
            <a href={zbackroomBillingUrl()}>Upgrade</a>
          </>
        ) : null}
      </p>

      {rooms.length === 0 ? (
        <p className="empty">No rooms yet. Create one to get two shareable call links.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Room</th>
                <th>Participants</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rooms.map((room) => (
                <tr key={room.id}>
                  <td>{room.label || <span className="muted">Untitled room</span>}</td>
                  <td className="muted">{room.participants.map((p) => p.name).join(" · ")}</td>
                  <td className="muted">{fmt(room.createdAt)}</td>
                  <td>
                    <Link href={`/rooms/${room.id}`} className="button-small">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
