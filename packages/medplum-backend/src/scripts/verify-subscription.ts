/**
 * End-to-end verification of the Subscription → Bot loop against the LOCAL self-hosted Medplum
 * (the brief's step-5 verify: "a Subscription fires the Bot end to end"). Synthetic data only.
 *
 * Run: pnpm --filter @medibun/medplum-backend verify:subscription
 * (loads infra/medplum/.env via tsx --env-file; requires the local stack running.)
 *
 * Prereq: run infra/medplum/setup-dev.sh first — it creates the ClientApplication AND the Bot
 * (with a ProjectMembership, required for the bot to execute) and writes infra/medplum/.env
 * including MEDPLUM_BOT_ID.
 *
 * Steps: authenticate → deploy the pre-created Bot's code → upsert a Subscription on Patient →
 * create a synthetic Patient → poll for the Bot's AuditEvent → print PASS/FAIL.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { authenticatedMedplumClient, readConfigFromEnv } from "../client.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const medplum = await authenticatedMedplumClient(readConfigFromEnv());
  console.log("✓ authenticated against", readConfigFromEnv().baseUrl);

  const botId = process.env.MEDPLUM_BOT_ID;
  if (!botId) {
    throw new Error("MEDPLUM_BOT_ID not set — run infra/medplum/setup-dev.sh first.");
  }

  // 1. Deploy the (already-created, membership-backed) Bot's code.
  const code = readFileSync(resolve(here, "../bots/hello-world.bot.ts"), "utf8");
  await medplum.post(medplum.fhirUrl("Bot", botId, "$deploy"), { code });
  console.log("✓ bot deployed:", botId);

  // 2. Upsert the Subscription: Patient create → rest-hook to the Bot.
  const existing = await medplum.searchOne("Subscription", {
    criteria: "Patient",
    url: `Bot/${botId}`,
  });
  if (!existing) {
    await medplum.createResource({
      resourceType: "Subscription",
      status: "active",
      reason: "step-5 verification",
      criteria: "Patient",
      channel: { type: "rest-hook", endpoint: `Bot/${botId}` },
    });
  }
  console.log("✓ subscription active on Patient → Bot");

  // 3. Create a synthetic, non-PHI test Patient.
  const patient = await medplum.createResource({
    resourceType: "Patient",
    name: [{ given: ["Test"], family: "Synthetic" }],
  });
  console.log("✓ created synthetic Patient:", patient.id);

  // 4. Poll for the Bot's AuditEvent referencing this patient.
  const deadline = Date.now() + 20_000;
  let found = undefined;
  while (Date.now() < deadline) {
    found = await medplum.searchOne("AuditEvent", {
      entity: `Patient/${patient.id}`,
    });
    if (found) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (found) {
    console.log("✓ bot fired — AuditEvent:", found.id);
    console.log("\nPASS: Subscription fired the Bot end to end.");
  } else {
    console.error("\nFAIL: no AuditEvent observed within 20s. Check the server logs and that the bot deployed.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
