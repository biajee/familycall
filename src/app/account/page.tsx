import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, zbackroomLoginUrl, zbackroomAccountUrl, zbackroomBillingUrl } from "@/lib/auth";
import { planLabel } from "@/lib/plan";

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect(zbackroomLoginUrl("/account"));

  return (
    <main className="container" style={{ maxWidth: 420 }}>
      <Link href="/app">&larr; My Rooms</Link>
      <h1 style={{ marginTop: 16 }}>Account</h1>
      <p className="muted">Signed in as {user.email}</p>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Plan</h3>
        <p style={{ marginBottom: 12 }}>
          <span className="badge badge-plan">{planLabel(user.plan)}</span>
        </p>
        <p className="muted" style={{ marginBottom: 16 }}>
          Calls are unlimited on every plan; plans differ in live-caption minutes and rooms.
          Subscriptions are managed at zbackroom.com, and each app there has its own.
        </p>
        <a className="button-secondary" href={zbackroomBillingUrl()}>
          Manage billing at zbackroom.com
        </a>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Profile &amp; password</h3>
        <p className="muted" style={{ marginBottom: 16 }}>
          Your sign-in — email, password, and connected Google account — is managed at
          zbackroom.com, since it&apos;s shared across every app there.
        </p>
        <a className="button-secondary" href={zbackroomAccountUrl()}>
          Manage account at zbackroom.com
        </a>
      </div>
    </main>
  );
}
