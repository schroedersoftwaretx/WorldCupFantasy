/**
 * Shared request/response shapes for the web app.
 *
 * These are the contract between the route handlers under `app/api` and any
 * client that consumes them. They are intentionally plain - dates are
 * ISO strings, not `Date` objects - so a JSON round-trip is lossless.
 *
 * The standings shape reuses the backend's `StandingsEntry` directly: it is
 * already a pure, serializable value object.
 */
import type { StandingsEntry } from "../data/standings/standings.js";

export type { StandingsEntry } from "../data/standings/standings.js";

/** GET /api/health */
export interface HealthData {
  status: "ok";
  /** Whether a `select 1` against the database succeeded. */
  db: "up" | "down";
  /** Whether the Firebase Admin service-account env vars are all present. */
  firebaseAdmin: "configured" | "unconfigured";
  /** Server time, ISO 8601. */
  time: string;
}

/** One league, as shown in a list. */
export interface LeagueSummary {
  id: number;
  name: string;
  /** League lifecycle status: SETUP / DRAFTING / IN_SEASON / COMPLETE. */
  status: string;
  maxManagers: number;
  rosterSize: number;
  /** Current number of managers in the league. */
  memberCount: number;
  /** ISO 8601. */
  createdAt: string;
}

/** One manager's place in a league. */
export interface LeagueMemberInfo {
  managerId: number;
  displayName: string;
  /** OWNER or MEMBER. */
  role: string;
  /** The manager's fantasy team in this league, if one exists yet. */
  teamId: number | null;
  teamName: string | null;
}

/** GET /api/leagues/[leagueId] */
export interface LeagueDetail extends LeagueSummary {
  members: LeagueMemberInfo[];
}

/** GET /api/standings/[leagueId] */
export interface StandingsData {
  leagueId: number;
  leagueName: string;
  standings: StandingsEntry[];
}

/** POST /api/auth/session - identity returned after establishing a session. */
export interface AuthSessionData {
  /** The resolved manager's id, or null if provisioning could not complete. */
  managerId: number | null;
  displayName: string | null;
}

/** POST /api/leagues - the league that was created. */
export interface LeagueCreatedData {
  leagueId: number;
  name: string;
}

/** POST /api/leagues/[leagueId]/invites - a freshly generated invite. */
export interface InviteCreatedData {
  token: string;
  /** Site-relative join path, e.g. "/invite/abc123". */
  path: string;
}

/** POST /api/invites/[token]/accept - the league that was joined. */
export interface InviteAcceptedData {
  leagueId: number;
}

/** A league invite looked up by token, for the join page. */
export interface InviteLookup {
  token: string;
  leagueId: number;
  leagueName: string;
  /** PENDING / ACCEPTED / REVOKED. */
  status: string;
  /** ISO 8601. */
  expiresAt: string;
}

// --- W4: the draft room -----------------------------------------------------

/** A draft's lifecycle: NONE = no draft room created for the league yet. */
export type DraftStatus = "NONE" | "PENDING" | "IN_PROGRESS" | "COMPLETE";

/** One slot of the frozen round-1 snake order. */
export interface DraftOrderSlot {
  slot: number;
  fantasyTeamId: number;
  teamName: string;
  managerName: string;
}

/** One completed pick, for the draft log. */
export interface DraftPickLog {
  pickNumber: number;
  round: number;
  fantasyTeamId: number;
  teamName: string;
  playerId: number;
  playerName: string;
  position: string;
  isAutopick: boolean;
}

/** A player on the viewer's roster. */
export interface DraftRosterPlayer {
  playerId: number;
  fullName: string;
  position: string;
}

/** Position tallies for a roster. */
export interface DraftPositionCounts {
  GK: number;
  DEF: number;
  MID: number;
  FWD: number;
}

/** The signed-in viewer's slice of the draft state. */
export interface DraftViewer {
  managerId: number;
  fantasyTeamId: number;
  teamName: string;
  isOwner: boolean;
  isOnClock: boolean;
  roster: DraftRosterPlayer[];
  counts: DraftPositionCounts;
}

/** GET /api/leagues/[leagueId]/draft - the polled draft state. */
export interface DraftStateData {
  status: DraftStatus;
  draftRoomId: number | null;
  pickTimerHours: number | null;
  rosterSize: number;
  /** Managers (teams) in the league - useful before the order is frozen. */
  teamCount: number;
  totalPicks: number;
  picksMade: number;
  currentPickNumber: number | null;
  currentRound: number | null;
  /** ISO 8601, or null when not in progress. */
  currentPickDeadline: string | null;
  onClockTeamId: number | null;
  order: DraftOrderSlot[];
  picks: DraftPickLog[];
  viewer: DraftViewer;
}

/** One available player on the draft board. */
export interface DraftBoardPlayer {
  id: number;
  fullName: string;
  position: string;
  nationalTeam: string;
  draftRank: number | null;
  /** Whether adding this player would be a legal roster move for the viewer. */
  legal: boolean;
}

/** GET /api/leagues/[leagueId]/draft/board - the available-player board. */
export interface DraftBoardData {
  players: DraftBoardPlayer[];
}

// --- W5: standings / in-season view ------------------------------------------

/** One player's scoring summary across all periods, for the roster view. */
export interface RosterPlayerScore {
  playerId: number;
  fullName: string;
  position: string;
  nationalTeam: string;
  /** Cumulative best-ball points this player contributed across all periods. */
  totalPoints: number;
  /** Raw (non-best-ball) points this player scored in each period. */
  periods: Array<{
    stage: string;
    points: number;
    /** True when this player was selected in the best-ball XI for the period. */
    inXi: boolean;
  }>;
}

/** GET /api/leagues/[leagueId]/roster?teamId=N */
export interface RosterViewData {
  leagueId: number;
  teamId: number;
  teamName: string;
  managerId: number;
  managerName: string;
  /** The 23 rostered players with their scoring detail. */
  players: RosterPlayerScore[];
  /** Total best-ball points (matches the standings entry). */
  total: number;
}

/** POST /api/leagues/[leagueId]/standings/recompute */
export interface RecomputeResult {
  inserted: number;
  updated: number;
  skipped: number;
}
