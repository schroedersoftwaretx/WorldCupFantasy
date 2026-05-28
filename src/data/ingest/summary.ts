/**
 * Counters returned by each ingestion command so the CLI can print a concise
 * summary. Keep this tiny — it is part of the public surface tests assert on.
 */
export interface IngestSummary {
  inserted: number;
  updated: number;
  skipped: number;
}

export function emptySummary(): IngestSummary {
  return { inserted: 0, updated: 0, skipped: 0 };
}

export function formatSummary(s: IngestSummary): string {
  return `inserted=${s.inserted} updated=${s.updated} skipped=${s.skipped}`;
}
