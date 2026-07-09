-- Shootout result on stat_line: kicks scored / conceded in a penalty shootout.
-- New raw counters. DEFAULT 0 keeps every existing row valid, so recomputing
-- scores against the current ruleset is a no-op for non-shootout matches. These
-- power the goalkeeper "game won" bonus on a shootout win: with reg+ET level,
-- team_shootout_scored > team_shootout_conceded means the team advanced.
-- Kept separate from the reg+ET goal counters so goals / clean sheets stay
-- shootout-free. No ruleset change, so the default ruleset version is unchanged.
ALTER TABLE "stat_line" ADD COLUMN "team_shootout_scored" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stat_line" ADD COLUMN "team_shootout_conceded" integer DEFAULT 0 NOT NULL;
