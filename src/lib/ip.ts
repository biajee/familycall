import { headers } from "next/headers";

// Works from anywhere in a request's call stack — Server Components,
// Server Actions, Route Handlers — since next/headers reads from the
// same request-scoped context regardless of how deep the call is. nginx
// sets both (see deploy/nginx-familycall.conf); X-Forwarded-For can be a
// client,proxy1,proxy2 chain, so take the first entry.
export async function getClientIp(): Promise<string | null> {
  const hdrs = await headers();
  const forwarded = hdrs.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return hdrs.get("x-real-ip");
}
