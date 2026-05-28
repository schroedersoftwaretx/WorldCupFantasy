/**
 * Edge middleware: redirect unauthenticated visitors to the sign-in page.
 *
 * This is a cheap presence check only - it confirms a session cookie exists,
 * not that it is valid. Real verification (the Firebase Admin SDK) happens in
 * each page and route handler, which run on the Node runtime. firebase-admin
 * is not Edge-safe, so middleware must not import it - it only reads the
 * cookie, via the import-free `SESSION_COOKIE` constant.
 *
 * The originally requested path is preserved as `?next=` so that, after
 * signing in, the visitor lands where they were headed (e.g. an invite link).
 *
 * The matcher excludes API routes (they self-gate and return JSON 401s),
 * Next internals, and the login page itself.
 */
import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/web/auth/constants";

export function middleware(request: NextRequest): NextResponse {
  if (request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.next();
  }
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  const target = request.nextUrl.pathname;
  if (target && target !== "/") {
    loginUrl.searchParams.set("next", target);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|login).*)"],
};
