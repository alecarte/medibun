/**
 * Dev utility: create one SYNTHETIC patient in the local self-hosted Medplum and
 * print its id. Synthetic, non-PHI data only — never run against a production
 * project. Run: pnpm --filter @medibun/medplum-backend seed:patient
 */
import { authenticatedMedplumClient, readConfigFromEnv } from "../client.js";

async function main(): Promise<void> {
  const client = await authenticatedMedplumClient(readConfigFromEnv());
  const patient = await client.createResource({
    resourceType: "Patient",
    name: [{ given: ["Synthia"], family: "Example" }],
    birthDate: "1990-01-01",
  });
  console.log(patient.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
