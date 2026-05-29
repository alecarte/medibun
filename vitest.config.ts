import { defineConfig } from "vitest/config";

/**
 * Root Vitest config. Uses the inline `projects` field (Vitest 4) instead of the
 * deprecated vitest.workspace.ts. Each web app and shared package supplies its own
 * vitest.config.ts. The Expo app (apps/patient-mobile) is intentionally excluded —
 * it tests with jest-expo, which Vitest cannot replace for React Native.
 */
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/portal", "apps/staff"],
  },
});
