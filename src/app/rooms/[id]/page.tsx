import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, zbackroomLoginUrl } from "@/lib/auth";
import { buildCallLink } from "@/lib/rooms";
import { deleteRoom } from "@/app/actions";
import CopyButton from "@/components/CopyButton";

const LANG_LABEL: Record<string, string> = { "zh-CN": "Mandarin", "en-US": "English", auto: "Auto (中/英)" };

function fmt(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toISOString().slice(0, 16).replace("T", " ");
}

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  const { id } = await params;
  if (!user) redirect(zbackroomLoginUrl(`/rooms/${id}`));

  const room = await prisma.room.findFirst({
    where: { id, accountId: user.id, deletedAt: null },
    include: {
      participants: { orderBy: { slot: "asc" } },
      callSessions: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
  if (!room) notFound();

  return (
    <main className="container">
      <Link href="/app">&larr; My Rooms</Link>
      <div className="header-row" style={{ marginTop: 16 }}>
        <h1>{room.label || "Untitled room"}</h1>
        <form action={deleteRoom.bind(null, room.id)}>
          <button type="submit" className="button-small">
            Delete room
          </button>
        </form>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Call links</h3>
        <p className="muted" style={{ marginBottom: 16 }}>
          Send each person only their own link — it already has their name, language, and caption
          size baked in. Anyone with a link can join, so treat it like a password.
        </p>
        {room.participants.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <strong>{p.name}</strong>{" "}
              <span className="muted">
                · {LANG_LABEL[p.lang] ?? p.lang} · {p.ui === "zh" ? "中文 UI" : "English UI"}
                {p.simple ? " · simple mode" : ""}
              </span>
              <div className="mono">{buildCallLink(room.slug, p)}</div>
            </div>
            <CopyButton text={buildCallLink(room.slug, p)} />
          </div>
        ))}
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Recent calls</h3>
        {room.callSessions.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No calls yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Ended</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {room.callSessions.map((c) => (
                  <tr key={c.id}>
                    <td className="muted">{fmt(c.startedAt)}</td>
                    <td className="muted">{fmt(c.endedAt)}</td>
                    <td>{c.seconds != null ? `${Math.round(c.seconds / 60)} min` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
