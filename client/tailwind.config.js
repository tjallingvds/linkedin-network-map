/** @type {import('tailwindcss').Config} */
export default {
  // Tailwind is used sparingly — the design system lives in src/design/workspace.css
  // as CSS custom properties (oklch) to preserve the pixel-perfect Nontrivial aesthetic.
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  corePlugins: {
    preflight: false, // styles.css already resets html/body/buttons/inputs.
  },
  theme: { extend: {} },
  plugins: [],
};
