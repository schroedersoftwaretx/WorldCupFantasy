-- Change pick_timer_hours from integer to real so sub-hour timers (e.g. 0.25 = 15 min) are supported.
ALTER TABLE "draft_room" ALTER COLUMN "pick_timer_hours" TYPE real;
