import tailwindcssAnimate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */
export default {
  // Two systems coexist:
  //   1. The legacy CRM design system — CSS custom properties in
  //      src/design/workspace.css (--bg-0, --panel, --text, --accent …).
  //   2. midday's shadcn/Tailwind component library in src/ui — utility
  //      classes (bg-background, border-border, rounded-md …) resolved by
  //      the theme below. Its palette lives under --md-* vars so it never
  //      clobbers the legacy tokens (both define --accent, differently).
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  corePlugins: {
    // workspace.css already resets html/body/buttons/inputs. A minimal base
    // layer in index.css restores border-style so shadcn `border` utilities
    // render — without Tailwind preflight rewriting the legacy layout.
    preflight: false,
  },
  theme: {
    extend: {
      fontFamily: {
        sans: ["Hedvig Letters Sans", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        serif: ["Hedvig Letters Serif", "Iowan Old Style", "Georgia", "serif"],
        mono: ["Geist Mono", "ui-monospace", "monospace"],
      },
      colors: {
        border: "hsl(var(--md-border))",
        input: "hsl(var(--md-input))",
        ring: "hsl(var(--md-ring))",
        background: "hsl(var(--md-background))",
        foreground: "hsl(var(--md-foreground))",
        primary: {
          DEFAULT: "hsl(var(--md-primary))",
          foreground: "hsl(var(--md-primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--md-secondary))",
          foreground: "hsl(var(--md-secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--md-destructive))",
          foreground: "hsl(var(--md-destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--md-muted))",
          foreground: "hsl(var(--md-muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--md-accent))",
          foreground: "hsl(var(--md-accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--md-popover))",
          foreground: "hsl(var(--md-popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--md-card))",
          foreground: "hsl(var(--md-card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--md-radius)",
        md: "calc(var(--md-radius) - 2px)",
        sm: "calc(var(--md-radius) - 4px)",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "caret-blink": {
          "0%,70%,100%": { opacity: "1" },
          "20%,50%": { opacity: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "caret-blink": "caret-blink 1.25s ease-out infinite",
        shimmer: "shimmer 2.5s linear infinite",
      },
      screens: {
        "3xl": "1800px",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
