/** Observable Intuition mark — a ring of 16 vertical bars, tall on the
 *  horizontal flanks, short at top/bottom. Inherits currentColor. */
export function Logo({ size = 24 }: { size?: number }) {
  const bars = [
    [74.9, 41.0, 18.0], [72.8, 51.7, 17.2], [67.0, 61.5, 15.1], [58.2, 69.0, 11.8],
    [47.9, 73.0, 8.0], [37.6, 69.0, 11.8], [28.8, 61.5, 15.1], [23.0, 51.7, 17.2],
    [20.9, 41.0, 18.0], [23.0, 31.1, 17.2], [28.8, 23.4, 15.1], [37.6, 19.2, 11.8],
    [47.9, 19.0, 8.0], [58.2, 19.2, 11.8], [67.0, 23.4, 15.1], [72.8, 31.1, 17.2],
  ] as const;
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className="shrink-0"
      role="img"
      aria-label="Observable Intuition"
    >
      {bars.map(([x, y, h], i) => (
        <rect key={i} x={x} y={y} width="4.4" height={h} rx="1.5" fill="currentColor" />
      ))}
    </svg>
  );
}
