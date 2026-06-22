/**
 * Loading skeleton for league pages (overview, standings, draft, roster, …).
 * Mirrors the rough shape of those pages — a heading, the tab strip, and a
 * table — so the layout doesn't jump when the real content streams in.
 */
export default function LeagueLoading() {
  return (
    <div aria-busy="true" role="status" aria-live="polite">
      <span className="sr-only">Loading league…</span>
      <div
        className="skeleton skeleton-line"
        style={{ width: "40%", height: "1.6rem", marginBottom: "1rem" }}
      />
      <div
        className="skeleton skeleton-line"
        style={{ width: "60%", marginBottom: "1.5rem" }}
      />
      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1.5rem" }}>
        {[64, 80, 56, 72].map((w, i) => (
          <div
            key={i}
            className="skeleton"
            style={{ width: w, height: "2rem", borderRadius: "8px" }}
          />
        ))}
      </div>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="skeleton skeleton-line"
          style={{ width: "100%", height: "2.25rem", margin: "0.4rem 0" }}
        />
      ))}
    </div>
  );
}
