import { createApiClient } from "@medibun/api-client";
import { notFound } from "next/navigation";

import { PatientProfileCard } from "../../components/patient-profile-card";

/**
 * Dev-only vertical-slice page (Sprint 01, goal 4): proves portal → api-client →
 * BFF → Medplum with synthetic data. Server component; the BFF base URL never
 * reaches the client bundle. Requires the BFF running with API_DEV_UNAUTHENTICATED=1.
 */
export default async function DevPatientPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  if (process.env.NODE_ENV === "production") {
    // Defense in depth alongside the BFF's dev guard (security-reviewer, 2026-06-10).
    notFound();
  }

  const { id } = await searchParams;
  if (!id) {
    return <main className="p-8">Pass ?id=&lt;synthetic patient id&gt;.</main>;
  }

  const client = createApiClient({
    baseUrl: process.env.API_BASE_URL ?? "http://localhost:3001",
  });
  const profile = await client.getPatientProfile(id);

  return (
    <main className="mx-auto max-w-lg p-8">
      <h1 className="mb-4 text-2xl font-bold">Patient profile (dev slice)</h1>
      {profile ? <PatientProfileCard profile={profile} /> : <p>No patient with that id.</p>}
    </main>
  );
}
