import type { PatientProfile } from "@medibun/api-client";

export function PatientProfileCard({ profile }: { profile: PatientProfile }) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] p-6">
      <h2 className="text-xl font-semibold">{profile.name}</h2>
      <dl className="mt-3 space-y-1 text-sm">
        {profile.birthDate !== undefined && (
          <div className="flex gap-2">
            <dt className="text-[var(--color-muted-foreground,inherit)]">Date of birth</dt>
            <dd>{profile.birthDate}</dd>
          </div>
        )}
        <div className="flex gap-2">
          <dt className="text-[var(--color-muted-foreground,inherit)]">Patient ID</dt>
          <dd>{profile.id}</dd>
        </div>
      </dl>
    </section>
  );
}
