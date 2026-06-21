/**
 * Stage selector for the Stats Hub: a row of links to each scoring period's
 * Team of the Stage. Stages with no scores yet are shown disabled. Pure server
 * component — no client JS.
 */
import Link from "next/link";

import type { Stage } from "@/data/db/schema";

import { STAGE_LABEL, STAGE_ORDER } from "./stage-labels";

export function StageNav({
  current,
  scored,
  all = false,
}: {
  current: Stage | null;
  /** Stages that have any score_entry (the rest render disabled). */
  scored: readonly Stage[];
  /** True when the whole-tournament ("All") view is the current page. */
  all?: boolean;
}) {
  const scoredSet = new Set(scored);
  const anyScored = scored.length > 0;
  return (
    <nav className="stage-nav" aria-label="Tournament stage">
      {STAGE_ORDER.map((stage) => {
        const enabled = scoredSet.has(stage);
        const isCurrent = stage === current;
        const cls = `stage-chip${isCurrent ? " stage-chip-active" : ""}${
          enabled ? "" : " stage-chip-disabled"
        }`;
        if (!enabled) {
          return (
            <span key={stage} className={cls} aria-disabled="true">
              {STAGE_LABEL[stage]}
            </span>
          );
        }
        return (
          <Link
            key={stage}
            href={`/stats/team-of-the-stage/${stage}`}
            className={cls}
            aria-current={isCurrent ? "page" : undefined}
          >
            {STAGE_LABEL[stage]}
          </Link>
        );
      })}
      {/* Whole-tournament best XI. Enabled once any stage has scores. */}
      {anyScored ? (
        <Link
          href="/stats/team-of-the-stage/all"
          className={`stage-chip${all ? " stage-chip-active" : ""}`}
          aria-current={all ? "page" : undefined}
          title="Best XI across the whole tournament"
        >
          All
        </Link>
      ) : (
        <span
          className="stage-chip stage-chip-disabled"
          aria-disabled="true"
        >
          All
        </span>
      )}
    </nav>
  );
}
