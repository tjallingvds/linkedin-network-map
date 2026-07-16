/**
 * Shared avatar helpers. The Prospect type lives in @app/shared so client +
 * server agree on the shape. No mock data — all prospect data comes from the
 * backend at runtime.
 */
export type { Prospect } from "@app/shared";

// Flat, solid, slightly-muted avatar colours — Linear-style. No gradients.
// Medium lightness so white initials stay legible.
const AVATAR_COLORS = [
  "oklch(0.62 0.13 280)", // indigo
  "oklch(0.60 0.12 240)", // blue
  "oklch(0.58 0.11 200)", // teal
  "oklch(0.58 0.12 160)", // green
  "oklch(0.64 0.13 70)",  // amber
  "oklch(0.60 0.15 25)",  // red
  "oklch(0.60 0.13 340)", // pink
  "oklch(0.58 0.11 130)", // olive
];

export const initials = (n: string) =>
  n.split(" ").map((s) => s[0] ?? "").join("").slice(0, 2).toUpperCase();

// Name kept for compatibility with existing call sites; returns a solid colour.
export const avatarGrad = (i: number) =>
  AVATAR_COLORS[Math.abs(i) % AVATAR_COLORS.length]!;
