/**
 * World Cup Fantasy - database schema: enum declarations.
 *
 * Every pgEnum lives here so each domain module imports its enums from one
 * place. The enum-derived value-type aliases (Stage, Position, ...) sit next
 * to the enum they describe.
 */

import { pgEnum } from "drizzle-orm/pg-core";

// --- Enums -------------------------------------------------------------------

export const positionEnum = pgEnum("position", ["GK", "DEF", "MID", "FWD"]);
export const teamStatusEnum = pgEnum("team_status", ["ACTIVE", "ELIMINATED"]);
export const playerStatusEnum = pgEnum("player_status", ["ACTIVE", "UNKNOWN"]);
export const stageEnum = pgEnum("stage", [
  "GROUP_1",
  "GROUP_2",
  "GROUP_3",
  "R32",
  "R16",
  "QF",
  "SF",
  "THIRD_PLACE",
  "FINAL",
]);
export const fixtureStatusEnum = pgEnum("fixture_status", [
  "SCHEDULED",
  "LIVE",
  "FINISHED",
]);

export const leagueStatusEnum = pgEnum("league_status", [
  "SETUP",
  "DRAFTING",
  "ACTIVE",
  "COMPLETE",
]);
export const leagueRoleEnum = pgEnum("league_role", ["OWNER", "MEMBER"]);
export const inviteStatusEnum = pgEnum("invite_status", [
  "PENDING",
  "ACCEPTED",
  "REVOKED",
]);

/** Draft lifecycle. */
export const draftStatusEnum = pgEnum("draft_status", [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETE",
]);
/** Kinds of notification emitted by the draft. */
export const draftNotificationTypeEnum = pgEnum("draft_notification_type", [
  "DRAFT_STARTED",
  "ON_THE_CLOCK",
  "PICK_MADE",
  "AUTOPICK_MADE",
  "DRAFT_COMPLETE",
]);
/** Delivery state of a notification. */
export const notificationStatusEnum = pgEnum("notification_status", [
  "PENDING",
  "SENT",
  "FAILED",
]);

// --- App-wide notification hub (Phase 0) ------------------------------------

/**
 * Channel a {@link notification} is delivered through. IN_APP rows surface in
 * the bell/inbox; EMAIL rows are delivered out-of-band via the notify
 * transport (Resend).
 */
export const notificationChannelEnum = pgEnum("notification_channel", [
  "IN_APP",
  "EMAIL",
]);

/**
 * Lifecycle of an app-wide {@link notification}. Distinct from the draft's
 * `notification_status` enum because in-app notifications add a READ state.
 *   - IN_APP: created SENT (delivered to the inbox); READ once opened.
 *   - EMAIL:  created PENDING; SENT / FAILED after a delivery attempt.
 */
export const appNotificationStatusEnum = pgEnum("app_notification_status", [
  "PENDING",
  "SENT",
  "FAILED",
  "READ",
]);

// --- Enum-derived value types -----------------------------------------------

export type Stage = (typeof stageEnum.enumValues)[number];
export type Position = (typeof positionEnum.enumValues)[number];
export type FixtureStatus = (typeof fixtureStatusEnum.enumValues)[number];
export type TeamStatus = (typeof teamStatusEnum.enumValues)[number];
export type PlayerStatus = (typeof playerStatusEnum.enumValues)[number];
export type LeagueStatus = (typeof leagueStatusEnum.enumValues)[number];
export type LeagueRole = (typeof leagueRoleEnum.enumValues)[number];
export type InviteStatus = (typeof inviteStatusEnum.enumValues)[number];
export type DraftStatus = (typeof draftStatusEnum.enumValues)[number];
export type DraftNotificationType = (typeof draftNotificationTypeEnum.enumValues)[number];
export type NotificationStatus = (typeof notificationStatusEnum.enumValues)[number];
export type NotificationChannel = (typeof notificationChannelEnum.enumValues)[number];
export type AppNotificationStatus =
  (typeof appNotificationStatusEnum.enumValues)[number];
