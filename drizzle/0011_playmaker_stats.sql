-- Playmaker scoring: key passes and big chances created.
-- New raw counters on stat_line. DEFAULT 0 keeps every existing row valid, so
-- recomputing scores against the old ruleset is a no-op for these columns.
ALTER TABLE "stat_line" ADD COLUMN "key_passes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stat_line" ADD COLUMN "big_chances_created" integer DEFAULT 0 NOT NULL;
-- NOTE: adding keyPass / bigChanceCreated to the ruleset changes its content
-- hash, producing a NEW ruleset version. Leagues pinned to the old default must
-- be repointed (scripts/repoint-leagues.ts) and scores rebuilt
-- (recomputeAllRulesets) AFTER this migration runs. This file only adds the
-- raw columns; it intentionally does not touch league.scoring_ruleset.
