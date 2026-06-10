/**
 * Resend-backed Notifier.
 *
 * Sends the draft's transactional emails (most importantly the load-bearing
 * "you're on the clock" message) through Resend (https://resend.com). It
 * implements the same {@link Notifier} interface as the in-memory and console
 * notifiers, so it drops into the draft service without any other changes.
 *
 * The `resend` package is imported dynamically the first time an email is
 * sent. That keeps it an optional dependency: the project compiles and runs
 * (falling back to the no-op path) even when the package is not installed and
 * no API key is configured. Once `npm install resend` has run and
 * RESEND_API_KEY is set, real delivery begins automatically.
 */

import type {
  Notifier,
  NotifierResult,
  OutboundNotification,
} from "./notifier.js";

/** The slice of the Resend client surface we depend on. */
interface ResendLike {
  emails: {
    send(payload: {
      from: string;
      to: string | string[];
      subject: string;
      html: string;
      text: string;
    }): Promise<{ error: { message: string } | null }>;
  };
}

export interface ResendNotifierOptions {
  apiKey: string;
  /** The verified "from" address, e.g. "World Cup Fantasy <draft@yourdomain>". */
  from: string;
  /**
   * Public base URL of the app (no trailing slash), e.g.
   * "https://worldcup-fantasy.vercel.app". Used to build the draft-room link.
   * When absent, the email simply omits the button.
   */
  baseUrl?: string;
}

export class ResendNotifier implements Notifier {
  private client: ResendLike | null = null;
  private readonly from: string;
  private readonly baseUrl: string | undefined;
  private readonly apiKey: string;

  constructor(opts: ResendNotifierOptions) {
    this.apiKey = opts.apiKey;
    this.from = opts.from;
    this.baseUrl = opts.baseUrl?.replace(/\/+$/, "");
  }

  private async getClient(): Promise<ResendLike> {
    if (this.client) return this.client;
    // Dynamic import so `resend` stays an optional dependency.
    const mod = (await import("resend")) as unknown as {
      Resend: new (key: string) => ResendLike;
    };
    this.client = new mod.Resend(this.apiKey);
    return this.client;
  }

  async send(notification: OutboundNotification): Promise<NotifierResult> {
    try {
      const client = await this.getClient();
      const { error } = await client.emails.send({
        from: this.from,
        to: notification.to,
        subject: notification.subject,
        html: this.renderHtml(notification),
        text: this.renderText(notification),
      });
      if (error) return { delivered: false, error: error.message };
      return { delivered: true };
    } catch (e) {
      return {
        delivered: false,
        error: e instanceof Error ? e.message : "resend send failed",
      };
    }
  }

  /** The deep link to the relevant draft room, when we can build one. */
  private draftLink(notification: OutboundNotification): string | null {
    if (!this.baseUrl || notification.leagueId === undefined) return null;
    return `${this.baseUrl}/leagues/${notification.leagueId}/draft`;
  }

  private renderText(n: OutboundNotification): string {
    const link = this.draftLink(n);
    const team = n.teamName ? ` (team: ${n.teamName})` : "";
    return [
      `Hi ${n.toName}${team},`,
      "",
      n.body,
      ...(link ? ["", `Open the draft room: ${link}`] : []),
    ].join("\n");
  }

  private renderHtml(n: OutboundNotification): string {
    const link = this.draftLink(n);
    const team = n.teamName
      ? `<p style="margin:0 0 12px;color:#666;font-size:14px;">Team: <strong>${escapeHtml(
          n.teamName,
        )}</strong></p>`
      : "";
    const button = link
      ? `<p style="margin:24px 0 0;">
           <a href="${escapeHtml(link)}"
              style="display:inline-block;background:#1f6feb;color:#fff;text-decoration:none;
                     font-weight:600;padding:10px 18px;border-radius:6px;">
             Open the draft room
           </a>
         </p>`
      : "";
    return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
                        max-width:480px;color:#1a1a1a;line-height:1.5;">
      <h2 style="font-size:18px;margin:0 0 12px;">${escapeHtml(n.subject)}</h2>
      ${team}
      <p style="margin:0;">${escapeHtml(n.body)}</p>
      ${button}
    </div>`;
  }
}

/** Minimal HTML escaping for the small set of values we interpolate. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
