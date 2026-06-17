/**
 * Display labels for the nine tournament scoring periods, shared across the
 * public Stats Hub pages. Mirrors the maps the league standings page uses.
 */
import type { Stage } from "@/data/db/schema";

export const STAGE_ORDER: readonly Stage[] = [
  "GROUP_1",
  "GROUP_2",
  "GROUP_3",
  "R32",
  "R16",
  "QF",
  "SF",
  "THIRD_PLACE",
  "FINAL",
];

export const STAGE_LABEL: Record<Stage, string> = {
  GROUP_1: "G1",
  GROUP_2: "G2",
  GROUP_3: "G3",
  R32: "R32",
  R16: "R16",
  QF: "QF",
  SF: "SF",
  THIRD_PLACE: "3rd",
  FINAL: "Final",
};

export const STAGE_FULL: Record<Stage, string> = {
  GROUP_1: "Group Stage — Matchday 1",
  GROUP_2: "Group Stage — Matchday 2",
  GROUP_3: "Group Stage — Matchday 3",
  R32: "Round of 32",
  R16: "Round of 16",
  QF: "Quarter-finals",
  SF: "Semi-finals",
  THIRD_PLACE: "Third-place playoff",
  FINAL: "Final",
};
