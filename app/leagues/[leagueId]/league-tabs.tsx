/**
 * LeagueTabs - per-league navigation scaffolding (Phase 0 nav shell).
 *
 * A server component that reads the league's feature flags through the typed
 * helper (never a raw column) and renders the tab strip. The always-on tabs
 * (Overview, Standings, Draft) link to their real routes; tabs for features
 * that later phases fill in appear only when their flag is enabled, shown as
 * "(soon)" chips until that phase ships their route; the stats_hub flag links
 * out to the live public /stats hub (Phase 1). This is the gated surface
 * a commissioner's toggle reacts on. Settings shows for the owner only.
 */
import Link from "next/link";

import { eq } from "drizzle-orm";

import { league } from "@/data/db/schema";
import { getFlags, type FeatureFlag } from "@/data/league/feature-flags";
import { getDb } from "@/web/db";

/** Which tab is the current page, so it can render as active. */
type CurrentTab =
  | "overview"
  | "standings"
  | "draft"
  | "stats"
  | "awards"
  | "matchups"
  | "lineup"
  | "chips"
  | "chat"
  | "settings";

interface LeagueTabsProps {
  leagueId: number;
  isOwner: boolean;
  current?: CurrentTab;
}

/** Future-phase flags and the label each will surface in the tab strip. */
const FUTURE_TABS: ReadonlyArray<{ flag: FeatureFlag; label: string }> = [
  { flag: "bracket", label: "Bracket" },
  { flag: "survivor", label: "Survivor" },
];

export default async function LeagueTabs({
  leagueId,
  isOwner,
  current,
}: LeagueTabsProps) {
  let flags;
  let format: string | null = null;
  try {
    const db = getDb();
    flags = await getFlags(db, leagueId);
    const [lg] = await db
      .select({ format: league.format })
      .from(league)
      .where(eq(league.id, leagueId));
    format = lg?.format ?? null;
  } catch {
    flags = null;
  }

  const tabClass = (tab: CurrentTab) =>
    `league-tab${current === tab ? " active" : ""}`;

  return (
    <nav className="league-tabs" aria-label="League navigation">
      <Link
        href={`/leagues/${leagueId}`}
        className={tabClass("overview")}
        aria-current={current === "overview" ? "page" : undefined}
      >
        Overview
      </Link>
      <Link
        href={`/leagues/${leagueId}/standings`}
        className={tabClass("standings")}
        aria-current={current === "standings" ? "page" : undefined}
      >
        Standings
      </Link>
      <Link
        href={`/leagues/${leagueId}/draft`}
        className={tabClass("draft")}
        aria-current={current === "draft" ? "page" : undefined}
      >
        Draft
      </Link>
      {format === "SET_LINEUP" ? (
        <Link
          href={`/leagues/${leagueId}/lineup`}
          className={tabClass("lineup")}
          aria-current={current === "lineup" ? "page" : undefined}
        >
          Lineup
        </Link>
      ) : null}
      {flags && flags.head_to_head ? (
        <Link
          href={`/leagues/${leagueId}/matchups`}
          className={tabClass("matchups")}
          aria-current={current === "matchups" ? "page" : undefined}
        >
          Matchups
        </Link>
      ) : null}
      {flags && flags.chat ? (
        <Link
          href={`/leagues/${leagueId}/chat`}
          className={tabClass("chat")}
          aria-current={current === "chat" ? "page" : undefined}
        >
          Chat
        </Link>
      ) : null}
      {flags && flags.chips ? (
        <Link
          href={`/leagues/${leagueId}/chips`}
          className={tabClass("chips")}
          aria-current={current === "chips" ? "page" : undefined}
        >
          Chips
        </Link>
      ) : null}
      {flags && flags.stats_hub ? (
        <Link href="/stats" className={tabClass("stats")}>
          Stats Hub
        </Link>
      ) : null}
      {flags && flags.awards ? (
        <Link
          href={`/leagues/${leagueId}/awards`}
          className={tabClass("awards")}
          aria-current={current === "awards" ? "page" : undefined}
        >
          Trophy Room
        </Link>
      ) : null}
      {flags
        ? FUTURE_TABS.filter((t) => flags[t.flag]).map((t) => (
            <span
              key={t.flag}
              className="league-tab disabled"
              aria-disabled="true"
            >
              {t.label} (soon)
            </span>
          ))
        : null}
      {isOwner ? (
        <Link
          href={`/leagues/${leagueId}/settings`}
          className={tabClass("settings")}
          aria-current={current === "settings" ? "page" : undefined}
        >
          Settings
        </Link>
      ) : null}
    </nav>
  );
}
