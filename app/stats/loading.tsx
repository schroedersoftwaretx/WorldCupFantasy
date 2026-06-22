/**
 * Loading skeleton for the public Stats Hub segment (leaderboards, team of the
 * stage, player explorer, …). A heading, a stage-chip row, and table rows.
 */
export default function StatsLoading() {
  return (
    <div aria-busy="true" role="status" aria-live="polite">
      <span className="sr-only">Loading stats…</span>
      <div
        className="skeleton skeleton-line"
        style={{ width: "35%", height: "1.6rem", marginBottom: "1.25rem" }}
      />
      <div style={{ display: "flex", gap: "0.35rem", marginBottom: "1.5rem" }}>
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="skeleton"
            style={{ width: 44, height: "1.9rem", borderRadius: "999px" }}
          />
        ))}
      </div>
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="skeleton skeleton-line"
          style={{ width: "100%", height: "2rem", margin: "0.4rem 0" }}
        />
      ))}
    </div>
  );
}
