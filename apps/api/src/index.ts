import { serve } from "@hono/node-server";
import {
  authenticatedMedplumClient,
  readConfigFromEnv,
  readPatientById,
} from "@medibun/medplum-backend";

import { createApp, type AppDeps } from "./app.js";
import { readApiConfigFromEnv } from "./config.js";
import { checkMedplumConnection } from "./medplum.js";
import { toPatientProfile } from "./patients.js";

const config = readApiConfigFromEnv();

/**
 * Dev-only, synthetic data only: unauthenticated patient reads exist solely behind
 * API_DEV_UNAUTHENTICATED=1 until the approval-gated auth work lands. Fresh login
 * per call — same dev-only caveat as checkMedplumConnection.
 */
const getPatientProfile: AppDeps["getPatientProfile"] = config.devUnauthenticatedRoutes
  ? async (id) => {
      const client = await authenticatedMedplumClient(readConfigFromEnv());
      const patient = await readPatientById(client, id);
      return patient && toPatientProfile(patient);
    }
  : undefined;

const app = createApp({
  log: (entry) => console.log(JSON.stringify(entry)),
  checkMedplum: checkMedplumConnection,
  getPatientProfile,
});

if (config.devUnauthenticatedRoutes) {
  console.log(JSON.stringify({ msg: "DEV MODE: unauthenticated routes mounted" }));
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(JSON.stringify({ msg: "api listening", port: info.port }));
});
