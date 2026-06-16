/**
 * Email transport abstraction for the notification hub (Phase 0).
 *
 * Splits "how an email is physically sent" (this file) from "what email is
 * sent" (the notifiers / the notify service). Both the draft's
 * {@link ResendNotifier} and the app-wide notify service deliver EMAIL
 * notifications through one shared {@link ResendTransport}, so there is a single
 * place that talks to Resend.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailDeliveryResult {
  delivered: boolean;
  /** Set when delivered is false. */
  error?: string;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
}

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

export interface ResendTransportOptions {
  apiKey: string;
  /** Verified "from" address, e.g. "World Cup Fantasy <noreply@yourdomain>". */
  from: string;
}

/**
 * Resend-backed transport. The `resend` package is imported dynamically on the
 * first send so it stays an optional dependency: the project compiles and runs
 * without it installed. Once `npm install resend` has run and an API key is
 * configured, real delivery begins automatically.
 */
export class ResendTransport implements EmailTransport {
  private client: ResendLike | null = null;
  private readonly apiKey: string;
  private readonly from: string;

  constructor(opts: ResendTransportOptions) {
    this.apiKey = opts.apiKey;
    this.from = opts.from;
  }

  private async getClient(): Promise<ResendLike> {
    if (this.client) return this.client;
    const mod = (await import("resend")) as unknown as {
      Resend: new (key: string) => ResendLike;
    };
    this.client = new mod.Resend(this.apiKey);
    return this.client;
  }

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    try {
      const client = await this.getClient();
      const { error } = await client.emails.send({
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
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
}

/**
 * In-memory transport for tests. Records every message; `delivered` defaults to
 * true but can be forced to fail to exercise the retry path.
 */
export class RecordingTransport implements EmailTransport {
  readonly sent: EmailMessage[] = [];
  constructor(private readonly forceFail = false) {}

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    this.sent.push(message);
    if (this.forceFail) {
      return { delivered: false, error: "RecordingTransport: forced failure" };
    }
    return { delivered: true };
  }
}
