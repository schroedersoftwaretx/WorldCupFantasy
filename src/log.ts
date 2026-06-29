/**
 * Minimal, level-aware structured logger.
 *
 * Wraps `console` today but presents a backend-swappable surface: every call is
 * `logger.<level>(msg, fields?)`, and all output flows through the single `emit`
 * sink below. To ship logs to a real backend (Pino, Datadog, OTLP, …) later,
 * replace `emit` — the call sites never change.
 *
 * The level threshold is read once from `LOG_LEVEL` (debug|info|warn|error); it
 * defaults to `info` in production and `debug` elsewhere. This module lives at
 * `src/log.ts` so the framework-agnostic data layer (`src/data`), the web layer
 * (`src/web`) and the Next app (`app/`) can all import it without crossing layer
 * boundaries.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface LogRecord {
  level: LogLevel;
  msg: string;
  time: string;
  fields?: LogFields | undefined;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveThreshold(): LogLevel {
  const raw =
    (typeof process !== "undefined" ? process.env.LOG_LEVEL : undefined)?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  const nodeEnv = typeof process !== "undefined" ? process.env.NODE_ENV : undefined;
  return nodeEnv === "production" ? "info" : "debug";
}

const threshold = resolveThreshold();

const SINK: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

/** The single output sink. Swap this to redirect every log line. */
function emit(record: LogRecord): void {
  const { level, msg, fields } = record;
  if (fields && Object.keys(fields).length > 0) {
    SINK[level](msg, fields);
  } else {
    SINK[level](msg);
  }
}

function write(level: LogLevel, msg: string, fields?: LogFields): void {
  if (RANK[level] < RANK[threshold]) return;
  emit({ level, msg, time: new Date().toISOString(), fields });
}

export const logger = {
  debug: (msg: string, fields?: LogFields): void => write("debug", msg, fields),
  info: (msg: string, fields?: LogFields): void => write("info", msg, fields),
  warn: (msg: string, fields?: LogFields): void => write("warn", msg, fields),
  error: (msg: string, fields?: LogFields): void => write("error", msg, fields),
};

export type Logger = typeof logger;
