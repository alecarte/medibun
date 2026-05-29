import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "medplum-backend",
    environment: "node",
    // Offline unit tests only. The live Subscription→Bot e2e is a manual dev script
    // (verify:subscription) that needs the local Medplum stack running.
    include: ["src/**/*.test.ts"],
  },
});
