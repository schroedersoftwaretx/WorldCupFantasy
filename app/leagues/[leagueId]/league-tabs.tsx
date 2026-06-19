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

import { getFlags, type FeatureFlag } from "@/data/league/feature-flags";
import { getDb } from "@/web/db";

interface LeagueTabsProps {
  leagueId: number;
  isOwner: boolean;
}

/** Future-phase flags and the label each will surface in the tab strip. */
const FUTURE_TABS: ReadonlyArray<{ flag: FeatureFlag; label: string }> = [
  { flag: "chat", label: "Chat" },
  { flag: "head_to_head", label: "Head-to-head" },
  { flag: "bracket", label: "Bracket" },
  { flag: "survivor", label: "Survivor" },
];

export default async function LeagueTabs({
  leagueId,
  isOwner,
}: LeagueTabsProps) {
  let flags;
  try {
    flags = await getFlags(getDb(), leagueId);
  } catch {
    flags = null;
  }

  return (
    <nav className="league-tabs">
      <Link href={`/leagues/${leagueId}`} className="league-tab">
        Overview
      </Link>
      <Link href={`/leagues/${leagueId}/standings`} className="league-tab">
        Standings
      </Link>
      <Link href={`/leagues/${leagueId}/draft`} className="league-tab">
        Draft
      </Link>
      {flags && flags.stats_hub ? (
        <Link href="/stats" className="league-tab">
          Stats Hub
        </Link>
      ) : null}
      {flags && flags.awards ? (
        <Link href={`/leagues/${leagueId}/awards`} className="league-tab">
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
          className="league-tab"
        >
          Settings
        </Link>
      ) : null}
    </nav>
  );
}
