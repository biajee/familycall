import { NextRequest, NextResponse } from "next/server";

// Tags each request with its path/method as headers the (Node-runtime)
// root layout can read via next/headers — Prisma isn't available in Edge
// middleware, so the actual page-view write happens downstream, not here.
export function middleware(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname);
  headers.set("x-method", req.method);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Skip API routes, static/image-optimization internals, and the
  // favicon — only real page navigations should count as a "page view".
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
