"use client";

import {
  BookingError,
  createApiClient,
  type AvailabilitySlot,
  type PractitionerAvailability,
  type ServiceAvailability,
  type ServiceSummary,
} from "@medibun/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { formatDuration, formatPrice, formatSlotFull, formatSlotTime, groupSlotsByDay } from "../../lib/slots";

/** Friendly, PHI-free copy per booking error (DESIGN.md voice: what happened, what next). */
const ERROR_COPY = {
  slot_taken: "That time was just booked. Pick another.",
  unknown: "Something went wrong on our side. Your visit wasn't booked — try again.",
} as const;

type Phase =
  | { readonly kind: "pick" }
  // Optimistic: the confirmation renders the moment the patient books; `settled`
  // flips when the BFF's 201 lands. A failure rolls back to the picker calmly.
  | { readonly kind: "booked"; readonly slot: AvailabilitySlot; readonly settled: boolean };

export function BookingFlow({
  service,
  availability,
}: {
  readonly service: ServiceSummary;
  readonly availability: ServiceAvailability;
}) {
  const router = useRouter();
  const practitioners = availability.practitioners;
  const [practitionerId, setPractitionerId] = useState<string | undefined>(
    (practitioners.find((p) => p.slots.length > 0) ?? practitioners[0])?.practitionerId,
  );
  const [selected, setSelected] = useState<AvailabilitySlot | undefined>();
  // Slots the server said were taken since the page loaded — hidden locally until the
  // next refresh so the patient never re-picks a known-dead time.
  const [taken, setTaken] = useState<readonly string[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [error, setError] = useState<string | undefined>();

  const practitioner = practitioners.find((p) => p.practitionerId === practitionerId);

  async function book(slot: AvailabilitySlot, chosen: PractitionerAvailability) {
    setError(undefined);
    setPhase({ kind: "booked", slot, settled: false });
    try {
      // Same-origin /api proxy → BFF; the HttpOnly session cookie rides along.
      await createApiClient({ baseUrl: "/api" }).book({
        serviceCode: service.code,
        scheduleId: chosen.scheduleId,
        start: slot.start,
      });
      setPhase({ kind: "booked", slot, settled: true });
      // The RSC layer refetches availability so a back-navigation shows fresh times.
      router.refresh();
    } catch (err) {
      const code = err instanceof BookingError && err.code === "slot_taken" ? "slot_taken" : "unknown";
      if (code === "slot_taken") {
        setTaken((prev) => [...prev, slot.start]);
        setSelected(undefined);
        router.refresh();
      }
      setPhase({ kind: "pick" });
      setError(ERROR_COPY[code]);
    }
  }

  if (phase.kind === "booked") {
    return (
      <ConfirmationCard
        service={service}
        practitionerName={practitioner?.practitionerName ?? ""}
        timezone={practitioner?.timezone ?? "UTC"}
        slot={phase.slot}
        settled={phase.settled}
      />
    );
  }

  const visibleSlots = (practitioner?.slots ?? []).filter((s) => !taken.includes(s.start));
  const days = practitioner ? groupSlotsByDay(visibleSlots, practitioner.timezone) : [];

  return (
    <div>
      {practitioners.length > 1 && (
        <div role="group" aria-label="Practitioner" className="flex flex-wrap gap-2">
          {practitioners.map((p) => {
            const active = p.practitionerId === practitionerId;
            return (
              <button
                key={p.practitionerId}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setPractitionerId(p.practitionerId);
                  setSelected(undefined);
                }}
                className={
                  active
                    ? "rounded-control bg-brand-wash px-4 py-2 text-sm font-medium text-brand-primary"
                    : "rounded-control border border-border-hairline px-4 py-2 text-sm text-text-secondary"
                }
              >
                {p.practitionerName}
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-6 text-sm text-status-danger-text">
          {error}
        </p>
      )}

      {days.length === 0 ? (
        <p className="mt-6 max-w-md text-sm text-text-secondary">
          No open times in the next week. New openings appear here as the schedule changes.
        </p>
      ) : (
        <div className="mt-8 flex flex-col gap-8">
          {days.map((day) => (
            <section key={day.dayKey} aria-label={day.dayLabel}>
              <h2 className="text-sm font-semibold text-text-primary">{day.dayLabel}</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {day.slots.map((slot) => {
                  const active = selected?.start === slot.start;
                  return (
                    <button
                      key={slot.start}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setSelected(active ? undefined : slot)}
                      className={
                        active
                          ? "rounded-control bg-action-primary px-4 py-2 text-sm font-medium text-text-on-accent tabular-nums"
                          : "rounded-control border border-border-interactive px-4 py-2 text-sm text-text-primary tabular-nums hover:bg-surface-well"
                      }
                    >
                      {formatSlotTime(slot.start, practitioner!.timezone)}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {selected && practitioner && (
        <div className="sticky bottom-0 mt-10 -mx-2 rounded-lg border border-border-hairline bg-surface-card p-4 shadow-mid">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-text-secondary">
              {service.name} with {practitioner.practitionerName} ·{" "}
              <span className="tabular-nums">
                {formatSlotFull(selected.start, practitioner.timezone)}
              </span>
            </p>
            <button
              type="button"
              onClick={() => void book(selected, practitioner)}
              className="shrink-0 rounded-control bg-action-primary px-5 py-2 text-sm font-medium text-text-on-accent"
            >
              Book {formatSlotTime(selected.start, practitioner.timezone)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfirmationCard({
  service,
  practitionerName,
  timezone,
  slot,
  settled,
}: {
  readonly service: ServiceSummary;
  readonly practitionerName: string;
  readonly timezone: string;
  readonly slot: AvailabilitySlot;
  readonly settled: boolean;
}) {
  return (
    <div className="animate-confirm max-w-lg rounded-lg border border-border-hairline bg-surface-card p-8 shadow-low">
      <p className="type-kicker">Your visit</p>
      <h2 className="type-display mt-3 text-2xl text-text-primary">
        Booked for <span className="tabular-nums">{formatSlotFull(slot.start, timezone)}</span>
      </h2>
      <p className="mt-4 text-sm text-text-secondary">
        {service.name} with {practitionerName} ·{" "}
        <span className="tabular-nums">
          {formatDuration(service.durationMinutes)} · {formatPrice(service.priceCents)}
        </span>
      </p>
      <p aria-live="polite" className="mt-2 text-sm text-text-secondary">
        {settled ? "It's on the studio's schedule." : "Saving to your record…"}
      </p>
      <div className="mt-8">
        <Link
          href="/"
          className="inline-block rounded-control bg-action-primary px-5 py-2 text-sm font-medium text-text-on-accent"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
