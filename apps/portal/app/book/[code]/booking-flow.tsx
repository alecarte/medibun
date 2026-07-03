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

import {
  formatDuration,
  formatPrice,
  formatSlotFull,
  formatSlotTime,
  groupSlotsByDay,
} from "../../lib/slots";

/** Friendly, PHI-free copy per booking error (DESIGN.md voice: what happened, what next). */
const ERROR_COPY = {
  slot_taken: "That time was just booked. Pick another.",
  invalid_request: "That time is no longer offered. Pick a current one.",
  unknown: "Something went wrong on our side. Your visit wasn't booked — try again.",
} as const;

type Phase =
  | { readonly kind: "pick" }
  // Optimistic: the confirmation renders the moment the patient books, with the
  // practitioner captured at book time (independent of later availability refreshes);
  // `settled` flips when the BFF's 201 lands. A failure rolls back to the picker.
  | {
      readonly kind: "booked";
      readonly slot: AvailabilitySlot;
      readonly practitionerName: string;
      readonly timezone: string;
      readonly settled: boolean;
    };

/** Dead-slot key: per schedule, so one practitioner's 409 never hides another's slot. */
const slotKey = (scheduleId: string, start: string) => `${scheduleId}|${start}`;

export function BookingFlow({
  service,
  availability,
}: {
  readonly service: ServiceSummary;
  readonly availability: ServiceAvailability;
}) {
  const router = useRouter();
  const practitioners = availability.practitioners;
  // Everything is keyed by scheduleId (unique per entry) — a practitioner with two
  // schedules for one service stays two independently bookable columns.
  const [scheduleId, setScheduleId] = useState<string | undefined>(
    (practitioners.find((p) => p.slots.length > 0) ?? practitioners[0])?.scheduleId,
  );
  const [selected, setSelected] = useState<AvailabilitySlot | undefined>();
  // Slots the server said were taken since this availability was fetched — hidden
  // locally so the patient never re-picks a known-dead time. Reset whenever fresh
  // availability arrives (render-time reset on prop change): server truth wins.
  const [taken, setTaken] = useState<readonly string[]>([]);
  const [prevAvailability, setPrevAvailability] = useState(availability);
  if (prevAvailability !== availability) {
    setPrevAvailability(availability);
    setTaken([]);
    setSelected(undefined);
  }
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [error, setError] = useState<string | undefined>();

  const practitioner = practitioners.find((p) => p.scheduleId === scheduleId);

  async function book(slot: AvailabilitySlot, chosen: PractitionerAvailability) {
    setError(undefined);
    setPhase({
      kind: "booked",
      slot,
      practitionerName: chosen.practitionerName,
      timezone: chosen.timezone,
      settled: false,
    });
    try {
      // Same-origin /api proxy → BFF; the HttpOnly session cookie rides along.
      await createApiClient({ baseUrl: "/api" }).book({
        serviceCode: service.code,
        scheduleId: chosen.scheduleId,
        start: slot.start,
      });
      setPhase((current) => (current.kind === "booked" ? { ...current, settled: true } : current));
      // No router.refresh() here: a transient refetch failure must never replace a
      // successful confirmation with an error page. Navigating away refetches anyway.
    } catch (err) {
      const code =
        err instanceof BookingError && (err.code === "slot_taken" || err.code === "invalid_request")
          ? err.code
          : "unknown";
      if (code !== "unknown") {
        // The time is gone (taken or no longer offered): hide it, drop the selection,
        // and pull fresh availability so the picker converges on server truth.
        setTaken((prev) => [...prev, slotKey(chosen.scheduleId, slot.start)]);
        setSelected(undefined);
        router.refresh();
      }
      setPhase({ kind: "pick" });
      setError(ERROR_COPY[code]);
    }
  }

  if (phase.kind === "booked") {
    return <ConfirmationCard service={service} phase={phase} />;
  }

  const visibleSlots = practitioner
    ? practitioner.slots.filter((s) => !taken.includes(slotKey(practitioner.scheduleId, s.start)))
    : [];
  const days = practitioner ? groupSlotsByDay(visibleSlots, practitioner.timezone) : [];

  return (
    <div>
      {practitioners.length > 1 && (
        <div role="group" aria-label="Practitioner" className="flex flex-wrap gap-2">
          {practitioners.map((p) => {
            const active = p.scheduleId === scheduleId;
            return (
              <button
                key={p.scheduleId}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setScheduleId(p.scheduleId);
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
  phase,
}: {
  readonly service: ServiceSummary;
  readonly phase: Extract<Phase, { kind: "booked" }>;
}) {
  return (
    <div className="animate-confirm max-w-lg rounded-lg border border-border-hairline bg-surface-card p-8 shadow-low">
      <p className="type-kicker">Your visit</p>
      <h2 className="type-display mt-3 text-2xl text-text-primary">
        Booked for{" "}
        <span className="tabular-nums">{formatSlotFull(phase.slot.start, phase.timezone)}</span>
      </h2>
      <p className="mt-4 text-sm text-text-secondary">
        {service.name} with {phase.practitionerName} ·{" "}
        <span className="tabular-nums">
          {formatDuration(service.durationMinutes)} · {formatPrice(service.priceCents)}
        </span>
      </p>
      <p aria-live="polite" className="mt-2 text-sm text-text-secondary">
        {phase.settled ? "It's on the studio's schedule." : "Saving to your record…"}
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
