/**
 * Shared avatar helpers. The Prospect type lives in @app/shared so client +
 * server agree on the shape. No mock data — all prospect data comes from the
 * backend at runtime.
 */
export type { Prospect } from "@app/shared";

const AVATAR_GRADS: [string, string][] = [
  ["oklch(0.75 0.14 305)", "oklch(0.55 0.16 280)"],
  ["oklch(0.78 0.12 200)", "oklch(0.55 0.14 240)"],
  ["oklch(0.78 0.12 60)", "oklch(0.6 0.16 30)"],
  ["oklch(0.75 0.14 155)", "oklch(0.55 0.14 195)"],
  ["oklch(0.78 0.12 25)", "oklch(0.55 0.16 350)"],
  ["oklch(0.78 0.10 110)", "oklch(0.55 0.14 160)"],
];

export const initials = (n: string) =>
  n.split(" ").map((s) => s[0] ?? "").join("").slice(0, 2).toUpperCase();

export const avatarGrad = (i: number) => {
  const [a, b] = AVATAR_GRADS[Math.abs(i) % AVATAR_GRADS.length]!;
  return `linear-gradient(135deg, ${a}, ${b})`;
};
