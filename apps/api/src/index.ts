import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { readApiConfigFromEnv } from "./config.js";
import { checkMedplumConnection } from "./medplum.js";

const { port } = readApiConfigFromEnv();

const app = createApp({
  log: (entry) => console.log(JSON.stringify(entry)),
  checkMedplum: checkMedplumConnection,
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(JSON.stringify({ msg: "api listening", port: info.port }));
});
