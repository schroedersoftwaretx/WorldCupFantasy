/**
 * Notifier abstraction.
 *
 * Email notifications are load-bearing for the async draft: the whole UX
 * depends on reliably telling a manager it is their turn. To keep that
 * reliable AND testable, delivery is split in two:
 *
 *   1. The draft service writes a row to `draft_notification` (status
 *      PENDING) BEFORE attempting delivery. That row is the durable record
 *      - if delivery is deferred or fails, nothing is lost.
 *   2. A Notifier attempts actual delivery and reports success/failure.
 *
 * This file defines the Notifier boundary and two implementations:
 *
 *   RecordingNotifier  In-memory; tests inspect what was sent.
 *   ConsoleNotifier    Logs the email it WOULD send. This is the structured
 *                      stand-in for a real SMTP EmailNotifier - a real
 *                      implementation drops in here without touching the
 *                      draft service.
 *
 * No real SMTP and no mail dependency are taken yet; a production
 * EmailNotifier implements the same interface when the infrastructure and
 * credentials exist.
 */

import type { DraftNotificationType } from "../db/schema.js";

/** A message to deliver to one manager. */
export interface OutboundNotification {
  /** Recipient email address. */
  to: string;
  /** Recipient's display name, for friendlier rendering. */
  toName: string;
  type: DraftNotificationType;
  subject: string;
  body: string;
  /**
   * The league this notification concerns, when known. Lets a rich notifier
   * (e.g. email) build a direct link to the draft room. Optional so the
   * in-memory and console notifiers are unaffected.
   */
  leagueId?: number;
  /** The recipient's fantasy team name in that league, when known. */
  teamName?: string | null;
}

export interface NotifierResult {
  delivered: boolean;
  /** Set when delivered is false. */
  error?: string;
}

export interface Notifier {
  send(notification: OutboundNotification): Promise<NotifierResult>;
}

/**
 * In-memory Notifier for tests. Every send is recorded; `delivered`
 * defaults to true but can be forced to fail to exercise the retry path.
 */
export class RecordingNotifier implements Notifier {
  readonly sent: OutboundNotification[] = [];
  constructor(private readonly forceFail = false) {}

  async send(notification: OutboundNotification): Promise<NotifierResult> {
    this.sent.push(notification);
    if (this.forceFail) {
      return { delivered: false, error: "RecordingNotifier: forced failure" };
    }
    return { delivered: true };
  }

  /** Convenience: notifications of one type, in send order. */
  ofType(type: DraftNotificationType): OutboundNotification[] {
    return this.sent.filter((n) => n.type === type);
  }
}

/**
 * Logs the email it would send to stdout. Used by the CLI and offline
 * development; it always reports success. Swap for a real EmailNotifier
 * in production.
 */
export class ConsoleNotifier implements Notifier {
  async send(notification: OutboundNotification): Promise<NotifierResult> {
    console.log(
      `[notify] ${notification.type} -> ${notification.toName} <${notification.to}>: ` +
        notification.subject,
    );
    return { delivered: true };
  }
}
