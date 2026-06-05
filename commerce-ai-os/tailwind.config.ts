import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Brand palette for the dashboard shell.
        brand: {
          DEFAULT: "#7c3aed", // violet-600
          dark: "#5b21b6",
          light: "#ede9fe",
        },
        ink: "#0f172a", // slate-900
        muted: "#64748b", // slate-500
      },
    },
  },
  plugins: [],
};

export default config;
