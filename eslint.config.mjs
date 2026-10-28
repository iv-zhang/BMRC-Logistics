import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    ".firebase/**",
    "next-env.d.ts",
    ".context/**",
    "test-results/**",
    "playwright-report/**",
  ]),
  {
    // Emulator harness / e2e helpers read and write dynamically-shaped Firestore
    // docs (REST-decoded fields, hydrated snapshots); `any` is the honest type.
    files: ["scripts/**", "e2e/**", ".claude/skills/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // Node scripts: CommonJS require() is expected.
    files: ["**/*.cjs", "scripts/**/*.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
