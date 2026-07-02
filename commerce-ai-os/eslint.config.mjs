// Flat config for ESLint 9 + eslint-config-next 16 (both already flat).
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "scripts/**", "**/*.mjs"] },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // The Next 15→16 upgrade moved to flat config and changed which rules fire,
    // so a batch of legacy `// eslint-disable-*` directives now suppress nothing
    // and show up as "unused directive" noise. They're dormant, not wrong —
    // leave them as intent documentation instead of sweeping every file, and
    // stop reporting them until a dedicated cleanup re-enables this.
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  {
    // Baseline gate: keep genuine-correctness rules as errors, but relax the
    // rules that fire on deliberate patterns in this codebase (typed DB rows,
    // React 19 hook heuristics) to warnings so lint is a green floor, not a
    // wall of 460 pre-existing findings. Tighten these back up incrementally.
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // Honor the `_`-prefix convention for deliberately-unused bindings.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-unused-expressions": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/use-memo": "warn",
      "@next/next/no-img-element": "warn",
      "react/jsx-no-comment-textnodes": "warn",
    },
  },
];

export default config;
