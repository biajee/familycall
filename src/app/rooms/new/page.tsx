import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, zbackroomLoginUrl } from "@/lib/auth";
import { createRoom } from "@/app/actions";

function ParticipantFields({ slot, title }: { slot: "a" | "b"; title: string }) {
  return (
    <div className="field-group">
      <strong>{title}</strong>
      <div className="field-row">
        <label>
          Name
          <input name={`${slot}Name`} placeholder={slot === "a" ? "Dad" : "Daughter"} maxLength={32} />
        </label>
        <label>
          Spoken language
          <select name={`${slot}Lang`} defaultValue="zh-CN">
            <option value="zh-CN">Mandarin (中文)</option>
            <option value="en-US">English</option>
            <option value="auto">Auto (中/英 mixed)</option>
          </select>
        </label>
      </div>
      <div className="field-row">
        <label>
          Interface language
          <select name={`${slot}Ui`} defaultValue="zh">
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <label>
          Caption size (px)
          <input name={`${slot}Font`} type="number" min={20} max={60} defaultValue={30} />
        </label>
      </div>
      <label className="checkbox-label">
        <input type="checkbox" name={`${slot}Simple`} />
        Simple mode (one big &quot;Start call&quot; button — good for an older phone)
      </label>
    </div>
  );
}

export default async function NewRoomPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; label?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect(zbackroomLoginUrl("/rooms/new"));

  const { error, label } = await searchParams;

  return (
    <main className="container" style={{ maxWidth: 560 }}>
      <Link href="/app">&larr; My Rooms</Link>
      <h1 style={{ marginTop: 16, marginBottom: 20 }}>New room</h1>

      {error ? (
        <div className="panel" style={{ borderColor: "var(--bad-text)" }}>
          <p style={{ margin: 0, color: "var(--bad-text)" }}>{error}</p>
        </div>
      ) : null}

      <form action={createRoom} className="form">
        <label>
          Room label (just for your dashboard)
          <input name="label" defaultValue={label} placeholder="Wang family" maxLength={64} />
        </label>

        <ParticipantFields slot="a" title="Person A" />
        <ParticipantFields slot="b" title="Person B" />

        <button type="submit" className="button">
          Create room
        </button>
      </form>
    </main>
  );
}
