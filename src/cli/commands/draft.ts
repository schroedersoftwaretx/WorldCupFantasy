/**
 * Draft lifecycle subcommands: create, start, pick, tick, status.
 */

import { ConsoleNotifier } from "../../data/draft/notifier.js";
import {
  createDraftRoom,
  getDraftState,
  makePick,
  processExpiredPicks,
  startDraft,
} from "../../data/draft/service.js";
import { draftRoomByLeague, playerBySourceId, type Subcommand } from "../helpers.js";

export const draftCommands: Record<string, Subcommand> = {
  "draft:create": async ({ db, args }) => {
    const [leagueIdRaw, timerRaw] = args;
    if (!leagueIdRaw) throw new Error("usage: draft:create <leagueId> [pickTimerHours]");
    const room = await createDraftRoom(db, {
      leagueId: Number(leagueIdRaw),
      ...(timerRaw ? { pickTimerHours: Number(timerRaw) } : {}),
    });
    console.log(
      `draft room id=${room.id} league=${room.leagueId} ` +
        `timer=${room.pickTimerHours}h status=${room.status}`,
    );
  },
  "draft:start": async ({ db, args }) => {
    const [leagueIdRaw] = args;
    if (!leagueIdRaw) throw new Error("usage: draft:start <leagueId>");
    const room = await draftRoomByLeague(db, Number(leagueIdRaw));
    const started = await startDraft(db, {
      draftRoomId: room.id,
      notifier: new ConsoleNotifier(),
    });
    console.log(
      `draft started: ${started.totalPicks} picks, pick 1 on the clock, ` +
        `deadline ${started.currentPickDeadline?.toISOString()}`,
    );
  },
  "draft:pick": async ({ db, args }) => {
    const [leagueIdRaw, teamIdRaw, sourcePlayerId] = args;
    if (!leagueIdRaw || !teamIdRaw || !sourcePlayerId) {
      throw new Error("usage: draft:pick <leagueId> <fantasyTeamId> <sourcePlayerId>");
    }
    const room = await draftRoomByLeague(db, Number(leagueIdRaw));
    const p = await playerBySourceId(db, sourcePlayerId);
    const result = await makePick(db, {
      draftRoomId: room.id,
      fantasyTeamId: Number(teamIdRaw),
      playerId: p.id,
      notifier: new ConsoleNotifier(),
    });
    console.log(
      `pick #${result.pickNumber} (round ${result.round}): team ${teamIdRaw} ` +
        `selected ${p.fullName} (${p.position})`,
    );
  },
  "draft:tick": async ({ db }) => {
    const result = await processExpiredPicks(db, { notifier: new ConsoleNotifier() });
    console.log(
      `tick: ${result.autopicks} autopick(s) across ${result.draftsTouched} draft(s)`,
    );
  },
  "draft:status": async ({ db, args }) => {
    const [leagueIdRaw] = args;
    if (!leagueIdRaw) throw new Error("usage: draft:status <leagueId>");
    const room = await draftRoomByLeague(db, Number(leagueIdRaw));
    const state = await getDraftState(db, room.id);
    console.log(
      `draft id=${state.draftRoom.id} status=${state.draftRoom.status} ` +
        `picks=${state.picksMade}/${state.draftRoom.totalPicks}`,
    );
    if (state.onClock) {
      console.log(
        `  on the clock: pick #${state.onClock.pickNumber} (round ${state.onClock.round}) ` +
          `team ${state.onClock.fantasyTeamId}, deadline ` +
          `${state.draftRoom.currentPickDeadline?.toISOString()}`,
      );
    }
  },
};
