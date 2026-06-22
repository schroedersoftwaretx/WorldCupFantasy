/**
 * Root loading fallback (App Router). Shown via Suspense while a route's
 * server components fetch their data, so navigation never leaves a blank
 * screen. Individual segments can override this with a more content-shaped
 * skeleton (see app/leagues/[leagueId]/loading.tsx).
 */
export default function Loading() {
  return (
    <div className="boundary boundary-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p className="subtitle" style={{ margin: 0 }}>
        Loading&hellip;
      </p>
    </div>
  );
}
