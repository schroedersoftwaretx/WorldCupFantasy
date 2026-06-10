-- v2 scoring: fractional points, detailed-action stats, and manual-edit lock.

-- score_entry.points must hold fractional values (the 0.5 / 0.05 rules).
ALTER TABLE "score_entry" ALTER COLUMN "points" TYPE real;--> statement-breakpoint

-- New raw counters on stat_line. DEFAULT 0 keeps every existing row valid.
ALTER TABLE "stat_line" ADD COLUMN "team_scored_in_regulation_and_et" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stat_line" ADD COLUMN "shots_on_target" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stat_line" ADD COLUMN "shots_off_target" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stat_line" ADD COLUMN "tackles_successful" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stat_line" ADD COLUMN "crosses" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stat_line" ADD COLUMN "passes_completed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stat_line" ADD COLUMN "goals_conceded" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- Manual-edit lock: hand-edited rows must survive provider re-ingest.
ALTER TABLE "stat_line" ADD COLUMN "manually_edited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stat_line" ADD COLUMN "manual_note" text;--> statement-breakpoint

-- Move any pre-v2 league ruleset onto the new canonical default so the new
-- rules take effect immediately. Leagues already carrying a v2 ruleset (they
-- have the "shotOnTarget" key) are left untouched. NOTE: a pre-v2 *custom*
-- ruleset is also reset to default here -- re-apply customizations after.
UPDATE "league"
SET "scoring_ruleset" = '{"appearance":1,"played60Plus":1,"goalByPosition":{"GK":10,"DEF":6,"MID":5,"FWD":4},"assist":4,"save":1,"cleanSheetByPosition":{"GK":5,"DEF":5},"cleanSheetMinMinutes":60,"penaltySaved":2,"penaltyMissed":-2,"ownGoal":-2,"yellowCard":-1,"redCard":-5,"shotOnTarget":1,"shotOffTarget":0.5,"tackleSuccessful":0.5,"cross":0.5,"passCompleted":0.05,"goalConcededByKeeper":-1,"gameWonKeeper":5,"version":"wcf-v1-07a20a31"}'::jsonb
WHERE NOT ("scoring_ruleset" ? 'shotOnTarget');
