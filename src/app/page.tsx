import Link from "next/link";
import { zbackroomSignupUrl } from "@/lib/auth";

export const metadata = {
  title: "FamilyCall — video calls your hard-of-hearing parents can follow",
  description:
    "One-to-one video calls with live captions in Mandarin and English, shown large on both screens, so a hard-of-hearing family member can read every word.",
};

export default function MarketingPage() {
  return (
    <main>
      <div className="container" style={{ display: "flex", justifyContent: "flex-end", paddingTop: 16 }}>
        <Link href="/app" className="button-secondary">
          My Rooms
        </Link>
      </div>

      <section className="mkt-hero">
        <div className="container">
          <h1 className="mkt-h1">A video call your parents can actually follow.</h1>
          <p className="mkt-sub">
            Everything either person says is transcribed and shown as large text on both phones,
            live, in Mandarin and English. Built for a hard-of-hearing parent — no app store,
            no accounts for them to manage, just a link.
          </p>
          <div className="mkt-cta-row">
            <Link href={zbackroomSignupUrl("/rooms/new")} className="button">
              Create your first room free
            </Link>
            <a href="#how-it-works" className="button-secondary">
              See how it works
            </a>
          </div>
        </div>
      </section>

      <section id="how-it-works" className="mkt-section mkt-section-alt">
        <div className="container">
          <h2 className="mkt-h2">Set up once, call forever</h2>

          <div className="mkt-steps">
            <div className="mkt-step">
              <span className="mkt-step-num">1</span>
              <h3>Create a room</h3>
              <div className="mkt-mock">
                <div className="mkt-mock-line">
                  <strong>Wang family</strong>
                </div>
                <div className="mkt-mock-line muted">Dad · 中文 · simple mode</div>
                <div className="mkt-mock-line muted">Daughter · auto (中/英)</div>
              </div>
            </div>

            <div className="mkt-step">
              <span className="mkt-step-num">2</span>
              <h3>Send each person their link</h3>
              <div className="mkt-mock">
                <div className="mkt-mock-line muted">Send once by text or WeChat.</div>
                <div className="mkt-mock-line muted">Add to Home Screen — opens like an app.</div>
              </div>
            </div>

            <div className="mkt-step">
              <span className="mkt-step-num">3</span>
              <h3>Tap to call</h3>
              <div className="mkt-mock">
                <div className="mkt-mock-line">开始通话 · Start call</div>
                <div className="mkt-mock-line muted">Big captions appear on both screens.</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mkt-section">
        <div className="container">
          <h2 className="mkt-h2">Built for the hard part</h2>
          <div className="mkt-steps">
            <div className="mkt-step">
              <h3>Live captions, both directions</h3>
              <p className="muted">
                Each phone streams its own microphone to live speech-to-text — what you say
                appears as large text on their screen, and back.
              </p>
            </div>
            <div className="mkt-step">
              <h3>Works across the Great Firewall</h3>
              <p className="muted">
                No dependency on services mainland China blocks — built for calling family there
                from anywhere else, reliably.
              </p>
            </div>
            <div className="mkt-step">
              <h3>No app store for them</h3>
              <p className="muted">
                A Progressive Web App: open the link once, add it to the home screen, and it
                behaves like an app from then on — nothing to install or update.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="mkt-footer">
        <p className="muted">FamilyCall — part of the <a href="https://zbackroom.com">zbackroom.com</a> app suite.</p>
      </section>
    </main>
  );
}
