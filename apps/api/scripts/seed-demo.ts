/**
 * DEMO SEED — synthetic data only, LOCAL DEV ONLY (docs/V0_PROPOSAL.md §8: the demo runs
 * from one documented command sequence; this is the `pnpm demo:seed` step).
 *
 * Creates the Aureva booking groundwork in BOTH stores, idempotently:
 * - Medplum (clinical): Organization, Location, Practitioners (actor timezone extension),
 *   HealthcareServices (SchedulingParameters duration), Schedules (service + availability).
 * - Experience DB: the commercial service catalog rows (names, durations, prices, colors),
 *   reconciled to FHIR via `code` + `healthcareServiceId`. Price never enters FHIR.
 *
 * Self-verifies: runs $find against the seeded schedule and fails loudly if no slots come
 * back. Requires the local Medplum stack (infra/medplum/setup-dev.sh) and its .env.
 *
 * Failure posture is the local scripts' shared one (src/local-script.ts): the connection,
 * the exit code, and the print-`errorLine`-only rule come from `runLocalScript`, because a
 * driver failure's raw message carries the query it failed on and its bound parameters.
 * Synthetic data today — but the rule does not depend on what is in the database.
 */
import {
  authenticatedMedplumClient,
  buildHealthcareService,
  buildPractitioner,
  buildSchedule,
  findSlots,
  readConfigFromEnv,
} from "@medibun/medplum-backend";
import type { Identifier, Location, Organization, Resource } from "@medibun/fhir-types";

import { makeErrorLine, UsageError } from "../src/ingest/import-cli.js";
import { runLocalScript, type LocalScriptCli } from "../src/local-script.js";
import { createServiceCatalog } from "../src/services/catalog.js";

const IDENTIFIER_SYSTEM = "https://medibun.com/fhir/identifiers/demo-seed";
const identify = (value: string): Identifier[] => [{ system: IDENTIFIER_SYSTEM, value }];
const TZ = "America/New_York";

const SERVICES = [
  {
    id: "botox-standard",
    code: "svc-botox",
    name: "Botox",
    description: "Neuromodulator treatment, dosed per area.",
    durationMinutes: 30,
    priceCents: 39500,
    categoryColor: "sage",
  },
  {
    id: "dysport-standard",
    code: "svc-dysport",
    name: "Dysport",
    description: "Fast-onset neuromodulator alternative.",
    durationMinutes: 30,
    priceCents: 37500,
    categoryColor: "teal",
  },
  {
    id: "lip-filler",
    code: "svc-lip-filler",
    name: "Lip filler",
    description: "Hyaluronic-acid lip augmentation.",
    durationMinutes: 45,
    priceCents: 68000,
    categoryColor: "plum",
  },
] as const;

const PRACTITIONERS = [
  { key: "riley-reyes", given: "Riley", family: "Reyes", services: ["svc-botox", "svc-dysport"] },
  { key: "maya-chen", given: "Maya", family: "Chen", services: ["svc-lip-filler"] },
] as const;

/** The one line a failure may print. Only messages written in this file are safe in full;
 *  everything else — a driver error, a Medplum client error — degrades to a class name. */
const errorLine = makeErrorLine([UsageError], "demo seed failed");

async function main({ db, out }: Parameters<LocalScriptCli["run"]>[0]): Promise<void> {
  // Friendly preflight: the env comes from infra/medplum/.env, which setup-dev.sh writes
  // as its LAST step — if it's missing, setup didn't complete. (EXPERIENCE_DATABASE_URL
  // is `runLocalScript`'s own guard, and it has already passed by the time we are here.)
  if (!process.env.MEDPLUM_BASE_URL) {
    throw new UsageError(
      "Medplum env not found. Run the local stack setup first:\n" +
        "  cd infra/medplum && docker compose up -d && ./setup-dev.sh\n" +
        "(setup-dev.sh writes infra/medplum/.env when it completes successfully)",
    );
  }
  const client = await authenticatedMedplumClient(readConfigFromEnv());
  // TRUE upsert (conditional update): re-runs must reconcile shape changes onto existing
  // resources — createResourceIfNoneExist would return the old resource unchanged, so fixes
  // to builders (e.g. Schedule.serviceType for $find) would never reach an existing stack.
  const upsert = async <T extends Resource>(resource: T, key: string): Promise<T> =>
    client.upsertResource<T>(
      { ...resource, identifier: identify(key) } as T,
      `identifier=${encodeURIComponent(`${IDENTIFIER_SYSTEM}|${key}`)}`,
    );

  const org = await upsert<Organization>(
    { resourceType: "Organization", name: "Aureva", active: true },
    "org-aureva",
  );
  await upsert<Location>(
    {
      resourceType: "Location",
      name: "Aureva Studio",
      status: "active",
      managingOrganization: { reference: `Organization/${org.id}` },
    },
    "loc-aureva-studio",
  );
  out(`✓ Organization/${org.id} (Aureva) + Location`);

  const serviceIds = new Map<string, string>();
  for (const s of SERVICES) {
    const hs = await upsert(
      buildHealthcareService({ code: s.code, name: s.name, durationMinutes: s.durationMinutes }),
      `hs-${s.code}`,
    );
    serviceIds.set(s.code, hs.id!);
    out(`✓ HealthcareService/${hs.id} (${s.name})`);
  }

  const scheduleIds: string[] = [];
  for (const p of PRACTITIONERS) {
    const practitioner = await upsert(
      buildPractitioner({ given: p.given, family: p.family, timezone: TZ }),
      `prac-${p.key}`,
    );
    for (const code of p.services) {
      const service = SERVICES.find((s) => s.code === code);
      if (!service) throw new Error(`unknown service code ${code}`);
      const schedule = await upsert(
        buildSchedule({
          practitionerReference: `Practitioner/${practitioner.id}`,
          healthcareServiceReference: `HealthcareService/${serviceIds.get(code)}`,
          serviceCode: code,
          durationMinutes: service.durationMinutes,
          availability: {
            daysOfWeek: ["mon", "tue", "wed", "thu", "fri"],
            startTime: "09:00:00",
            endTime: "17:00:00",
          },
        }),
        `sched-${p.key}-${code}`,
      );
      scheduleIds.push(schedule.id!);
      out(`✓ Schedule/${schedule.id} (${p.family} · ${service.name})`);
    }
  }

  // Experience-DB catalog rows, reconciled to the FHIR ids. The connection is
  // runLocalScript's — it opened it and it closes it.
  const catalog = createServiceCatalog(db);
  for (const s of SERVICES) {
    await catalog.upsert({ ...s, healthcareServiceId: serviceIds.get(s.code) });
  }
  out(`✓ experience-DB service catalog (${SERVICES.length} rows)`);

  // Self-verify: $find on the first schedule for the next 7 days must yield slots.
  const start = new Date();
  const end = new Date(start.getTime() + 7 * 24 * 3600_000);
  const slots = await findSlots(client, {
    scheduleId: scheduleIds[0]!,
    healthcareServiceReference: `HealthcareService/${serviceIds.get(PRACTITIONERS[0].services[0])}`,
    start: start.toISOString(),
    end: end.toISOString(),
    count: 5,
  });
  if (slots.length === 0) {
    throw new UsageError("self-check FAILED: $find returned no slots for the seeded schedule");
  }
  out(`✓ self-check: $find returned ${slots.length} free slots (first: ${slots[0]!.start})`);
  out("DEMO SEED COMPLETE");
}

await runLocalScript({ run: main, errorLine });
