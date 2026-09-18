import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/ip";

type Level = "INFO" | "WARN" | "ERROR";

// Writes to both the DB (for the admin dashboard) and the console (for
// journalctl/systemd, which is where server crashes and framework errors
// already show up regardless). A logging failure must never break the
// request it's describing — always caught, never awaited by callers who
// can't afford to block on it.
export async function log(
  level: Level,
  source: string,
  message: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const line = `[${source}] ${message}`;
  if (level === "ERROR") console.error(line, meta ?? "");
  else if (level === "WARN") console.warn(line, meta ?? "");
  else console.log(line, meta ?? "");

  try {
    const ip = await getClientIp().catch(() => null);
    await prisma.appLog.create({
      data: { level, source, message, meta: meta ? JSON.stringify(meta) : null, ip },
    });
  } catch (err) {
    console.error("Failed to write app log:", err);
  }
}
