/**
 * Shared display formatting for the web UI.
 */

/**
 * Render a points value rounded to the nearest 2 decimal places, without
 * trailing-zero padding (7.4, 5.23, 10, -2.5). Use everywhere raw point
 * totals are shown so fractional scoring (passes, crosses, etc.) never leaks
 * float noise like 7.400000001 into the UI.
 *
 * Note: this rounds to the NEAREST 0.01. If you ever want to always round up
 * (ceil) instead, swap Math.round for Math.ceil.
 */
export function formatPoints(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}
