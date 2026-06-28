/**
 * The shared error / status banners at the top of every draft-room view.
 * Pure: the parent owns the action-error string and decides whether the
 * owner-only email-config warning should show.
 */
"use client";

interface StatusBannersProps {
  /** The most recent failed-action message, or null. */
  actionError: string | null;
  /**
   * Owner-only heads-up when email delivery isn't configured, so they know
   * managers won't get "you're on the clock" emails.
   */
  showEmailWarning: boolean;
}

export default function StatusBanners({
  actionError,
  showEmailWarning,
}: StatusBannersProps) {
  return (
    <>
      {actionError ? <p className="error">{actionError}</p> : null}
      {showEmailWarning ? (
        <p className="notice">
          Email notifications are off (Resend not configured) — managers
          won&apos;t get &ldquo;you&apos;re on the clock&rdquo; emails. Set
          <code> RESEND_API_KEY</code> to enable them.
        </p>
      ) : null}
    </>
  );
}
