/**
 * Root 404 page (App Router). Rendered for unmatched routes and any
 * `notFound()` call that isn't caught by a closer not-found boundary.
 */
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="boundary">
      <h1>Page not found</h1>
      <p className="subtitle">
        We couldn&apos;t find the page you were looking for. It may have moved,
        or the link may be out of date.
      </p>
      <div className="boundary-actions">
        <Link href="/" className="btn">
          Go to your leagues
        </Link>
      </div>
    </div>
  );
}
