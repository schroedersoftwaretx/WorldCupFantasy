/**
 * Resend-backed Notifier for the draft's transactional emails.
 *
 * Renders the draft email (subject/body + the load-bearing "open the draft
 * room" button) and delegates the actual send to the shared
 * {@link ResendTransport} in `src/data/notify/transport.ts`, so the draft and
 * the app-wide notification hub talk to Resend through one code path.
 *
 * It implements the same {@link Notifier} interface as the in-memory and
 * console notifiers, so it drops into the draft service without other changes.
 */

import { ResendTransport } from "../notify/transport.js";
import type {
  Notifier,
  NotifierResult,
  OutboundNotification,
} from "./notifier.js";

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
  private readonly transport: ResendTransport;
  private readonly baseUrl: string | undefined;

  constructor(opts: ResendNotifierOptions) {
    this.transport = new ResendTransport({
      apiKey: opts.apiKey,
      from: opts.from,
    });
    this.baseUrl = opts.baseUrl?.replace(/\/+$/, "");
  }

  async send(notification: OutboundNotification): Promise<NotifierResult> {
    const result = await this.transport.send({
      to: notification.to,
      subject: notification.subject,
      html: this.renderHtml(notification),
      text: this.renderText(notification),
    });
    const out: NotifierResult = { delivered: result.delivered };
    if (result.error !== undefined) out.error = result.error;
    return out;
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
