import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Luxury-beauty palette — warm caramel/gold brand on a cream shell.
        brand: {
          DEFAULT: "#a8683a", // caramel
          dark: "#8a5528",
          light: "#f7ece1",
        },
        ink: "#3f2a1d",   // warm espresso
        muted: "#9c8171", // warm taupe
        // Re-map the whole "violet" accent ramp to gold/caramel so every accent
        // already in the app (badges, active states, primary chips) reskins to
        // the luxury theme without touching each component.
        violet: {
          50: "#faf3ec", 100: "#f4e3d2", 200: "#e9c9a9", 300: "#dcae7f",
          400: "#ca9057", 500: "#b5763f", 600: "#a8683a", 700: "#8a5528",
          800: "#6f4420", 900: "#5b3819", 950: "#3f2a1d",
        },
      },
      fontFamily: {
        serif: ["Georgia", "Cambria", "\"Times New Roman\"", "serif"],
      },
    },
  },
  plugins: [],
};

export default config;
