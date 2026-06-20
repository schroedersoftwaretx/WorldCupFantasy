import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

import { getCurrentUser } from "@/web/auth/current-user";

import NotificationBell from "./notification-bell";
import SignOutButton from "./sign-out-button";
import "./globals.css";

export const metadata: Metadata = {
  title: "World Cup Fantasy",
  description: "2026 World Cup fantasy draft league",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Tolerate any auth error here - the header simply renders signed-out.
  let displayName: string | null = null;
  try {
    const user = await getCurrentUser();
    displayName = user?.manager.displayName ?? null;
  } catch {
    displayName = null;
  }

  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="site-title">
            World Cup Fantasy
          </Link>
          <nav className="site-nav">
            <Link href="/stats" className="site-nav-link">
              Stats
            </Link>
          </nav>
          {displayName ? (
            <span className="user-chip">
              <NotificationBell />
              {displayName}
              <SignOutButton />
            </span>
          ) : null}
        </header>
        <main className="site-main">{children}</main>
      </body>
    </html>
  );
}
