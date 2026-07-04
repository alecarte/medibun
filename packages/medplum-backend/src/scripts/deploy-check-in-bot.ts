/**
 * Deploy the check-in Bot's code and upsert its Subscription (S5, approval A7). LOCAL DEV:
 * called by infra/medplum/setup-dev.sh after it creates the Bot (with membership) and
 * writes infra/medplum/.env. Production deploys via the Medplum CLI (fhir.md rule) — this
 * script is the dev/CI equivalent, reviewed code, never the in-app editor.
 *
 * Run: pnpm --filter @medibun/medplum-backend deploy:bot:check-in
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { authenticatedMedplumClient, readConfigFromEnv } from "../client.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const botId = process.env.MEDPLUM_CHECKIN_BOT_ID;
  if (!botId) {
    throw new Error("MEDPLUM_CHECKIN_BOT_ID not set — run infra/medplum/setup-dev.sh first.");
  }
  const medplum = await authenticatedMedplumClient(readConfigFromEnv());

  const code = readFileSync(resolve(here, "../bots/check-in.bot.ts"), "utf8");
  await medplum.post(medplum.fhirUrl("Bot", botId, "$deploy"), { code });
  console.log("✓ check-in bot deployed:", botId);

  // arrived → create the Encounter; booked → void it on undo (new bookings no-op).
  const criteria = "Appointment?status=arrived,booked";
  const existing = await medplum.searchOne("Subscription", {
    criteria,
    url: `Bot/${botId}`,
  });
  if (!existing) {
    await medplum.createResource({
      resourceType: "Subscription",
      status: "active",
      reason: "S5 check-in: Appointment status drives the Encounter (A7)",
      criteria,
      channel: { type: "rest-hook", endpoint: `Bot/${botId}` },
    });
  }
  console.log("✓ subscription active:", criteria, "→ Bot/" + botId);
}

main().catch((err: unknown) => {
  console.error("FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
