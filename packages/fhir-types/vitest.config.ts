import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "fhir-types",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
