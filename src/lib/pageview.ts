import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/ip";

// Reads the path/method middleware tagged the request with (Prisma isn't
// available in Edge middleware, so the actual write happens here, in the
// Node runtime) and logs a page view — GET only, so a server action POST
// to the same URL doesn't get counted as a visit to that page. Never
// throws; a logging failure must not break the page it's describing.
export async function logPageView(userEmail: string | null): Promise<void> {
  const hdrs = await headers();
  if (hdrs.get("x-method") !== "GET") return;

  const path = hdrs.get("x-pathname");
  if (!path) return;

  try {
    const ip = await getClientIp();
    await prisma.pageView.create({ data: { path, userEmail, ip } });
  } catch (err) {
    console.error("Failed to log page view:", err);
  }
}
