import type { Metadata } from "next";
import { GoogleTag } from "@/components/GoogleTag";
import Link from "next/link";
import "./globals.css";
import { getCurrentUser, zbackroomLoginUrl, zbackroomLogoutUrl } from "@/lib/auth";
import { logPageView } from "@/lib/pageview";
import { planLabel } from "@/lib/plan";

export const metadata: Metadata = {
  title: "FamilyCall",
  description: "Video calls with live bilingual captions, for family members who are hard of hearing.",
};

// One header for every FamilyCall page, styled to match zbackroom.com's own
// (same site-header/wrap/wordmark structure, own accent color) so every app
// in the suite reads as one product instead of each page inventing its own
// nav bar — see ConfirmPO's layout.tsx for the original of this pattern.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  await logPageView(user?.email ?? null);

  return (
    <html lang="en">
      <head>
        <GoogleTag />
      </head>
      <body>
        <header className="site-header">
          <div className="wrap">
            <Link className="wordmark" href="/">
              FamilyCall
            </Link>
            <nav>
              <a href="https://zbackroom.com" className="zb-parent-link">
                zbackroom.com
              </a>
              {user ? (
                <>
                  <Link href="/app">My Rooms</Link>
                  <Link href="/account" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="badge badge-plan">{planLabel(user.plan)}</span>
                    <span>{user.email}</span>
                  </Link>
                  <a href={zbackroomLogoutUrl("/")}>Sign out</a>
                </>
              ) : (
                <a href={zbackroomLoginUrl("/app")}>Sign in</a>
              )}
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
