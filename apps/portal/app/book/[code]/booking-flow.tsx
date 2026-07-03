"use client";

import {
  BookingError,
  createApiClient,
  type AvailabilitySlot,
  type PractitionerAvailability,
  type ServiceAvailability,
  type ServiceSummary,
} from "@medibun/api-client";
import { tokens } from "@medibun/design-tokens";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Avatar } from "../../components/avatar";
import { buildIcs, icsDataUrl } from "../../lib/ics";
import {
  dayParts,
  dayStrip,
  formatDuration,
  formatPrice,
  formatSlotFull,
  formatSlotTime,
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
      readonly bookingId?: string;
    };

/** Dead-slot key: per schedule, so one practitioner's 409 never hides another's slot. */
const slotKey = (scheduleId: string, start: string) => `${scheduleId}|${start}`;

export function BookingFlow({
  service,
  availability,
  windowStartIso,
}: {
  readonly service: ServiceSummary;
  readonly availability: ServiceAvailability;
  /** The booking window's start (server "now") — pinned server-side so the 7-day strip
   *  renders identically on server and client. */
  readonly windowStartIso: string;
}) {
  const router = useRouter();
  const practitioners = availability.practitioners;
  // Everything is keyed by scheduleId (unique per entry) — a practitioner with two
  // schedules for one service stays two independently bookable columns.
  const [scheduleId, setScheduleId] = useState<string | undefined>(
    (practitioners.find((p) => p.slots.length > 0) ?? practitioners[0])?.scheduleId,
  );
  const [switching, setSwitching] = useState(false);
  const [selectedDayKey, setSelectedDayKey] = useState<string | undefined>();
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
  const defaultScheduleId = (practitioners.find((p) => p.slots.length > 0) ?? practitioners[0])
    ?.scheduleId;

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
      const booked = await createApiClient({ baseUrl: "/api" }).book({
        serviceCode: service.code,
        scheduleId: chosen.scheduleId,
        start: slot.start,
      });
      setPhase((current) =>
        current.kind === "booked" ? { ...current, settled: true, bookingId: booked.id } : current,
      );
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
  const strip = practitioner
    ? dayStrip(visibleSlots, practitioner.timezone, new Date(windowStartIso))
    : [];
  const maxDaySlots = Math.max(1, ...strip.map((d) => d.slots.length));
  const activeDay =
    strip.find((d) => d.dayKey === selectedDayKey && d.slots.length > 0) ??
    strip.find((d) => d.slots.length > 0);
  const parts = practitioner && activeDay ? dayParts(activeDay.slots, practitioner.timezone) : [];
  const hasAnySlots = strip.some((d) => d.slots.length > 0);

  return (
    <div>
      {practitioner && (
        <div className="rounded-lg border border-border-hairline bg-surface-card">
          <div className="flex items-center gap-3 px-4 py-3">
            <Avatar name={practitioner.practitionerName} />
            <p className="text-sm font-semibold text-text-primary">
              {practitioner.practitionerName}
              {practitioner.scheduleId === defaultScheduleId && (
                <span className="font-normal text-text-secondary"> · first available</span>
              )}
            </p>
            {practitioners.length > 1 && (
              <button
                type="button"
                aria-expanded={switching}
                onClick={() => setSwitching((s) => !s)}
                className="ml-auto text-sm font-medium text-brand-primary"
              >
                Switch practitioner
              </button>
            )}
          </div>
          {switching && (
            <div
              role="group"
              aria-label="Practitioner"
              className="flex flex-wrap gap-2 border-t border-border-hairline px-4 py-3"
            >
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
                      setSelectedDayKey(undefined);
                      setSwitching(false);
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
        </div>
      )}

      {error && (
        <p role="alert" className="mt-6 text-sm text-status-danger-text">
          {error}
        </p>
      )}

      {!hasAnySlots ? (
        <p className="mt-6 max-w-md text-sm text-text-secondary">
          No open times in the next week. New openings appear here as the schedule changes.
        </p>
      ) : (
        <>
          <div role="group" aria-label="Day" className="mt-6 flex gap-2">
            {strip.map((day) => {
              const active = day.dayKey === activeDay?.dayKey;
              const empty = day.slots.length === 0;
              return (
                <button
                  key={day.dayKey}
                  type="button"
                  aria-label={day.dayLabel}
                  aria-pressed={active}
                  disabled={empty}
                  onClick={() => {
                    setSelectedDayKey(day.dayKey);
                    setSelected(undefined);
                  }}
                  className={`flex-1 rounded-lg border px-1 pt-2 pb-2 text-center ${
                    active
                      ? "border-brand-primary bg-brand-wash"
                      : empty
                        ? "border-border-hairline bg-surface-card opacity-45"
                        : "border-border-hairline bg-surface-card"
                  }`}
                >
                  <span
                    className={`block text-[11px] tracking-wide uppercase ${active ? "text-brand-primary" : "text-text-secondary"}`}
                  >
                    {day.weekday}
                  </span>
                  <span
                    className={`mt-0.5 block text-base font-semibold tabular-nums ${active ? "text-brand-primary" : "text-text-primary"} ${empty ? "line-through decoration-1" : ""}`}
                  >
                    {day.dayOfMonth}
                  </span>
                  {/* Truthful per-day fullness — derived from real open-slot counts. */}
                  <span
                    aria-hidden
                    className="mx-auto mt-1.5 block h-0.5 w-3/4 overflow-hidden rounded-full bg-surface-well"
                  >
                    <span
                      className="block h-full bg-brand-primary opacity-40"
                      style={{
                        width: `${Math.round((1 - day.slots.length / maxDaySlots) * 100)}%`,
                      }}
                    />
                  </span>
                </button>
              );
            })}
          </div>

          {activeDay && (
            <div className="mt-2 flex flex-col gap-6 pt-4">
              {parts.map((part) => (
                <section key={part.label} aria-label={`${part.label}, ${activeDay.dayLabel}`}>
                  <h2 className="type-kicker">{part.label}</h2>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {part.slots.map((slot) => {
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
        </>
      )}

      {selected && practitioner && (
        <div className="sticky bottom-4 mt-10 rounded-lg border border-border-hairline bg-surface-card p-4 shadow-mid">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-text-secondary">
              <span className="font-semibold text-text-primary">
                {service.name} with {practitioner.practitionerName}
              </span>{" "}
              ·{" "}
              <span className="tabular-nums">
                {formatSlotFull(selected.start, practitioner.timezone)}
              </span>
              <span className="mt-0.5 block text-xs">Reschedule free up to 24 hours before.</span>
            </p>
            <button
              type="button"
              onClick={() => void book(selected, practitioner)}
              className="shrink-0 rounded-control bg-action-primary px-5 py-2.5 text-sm font-medium text-text-on-accent"
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
  const brandName = tokens["brand-name"];
  const ics = buildIcs({
    id: phase.bookingId ?? `${service.code}-${phase.slot.start}`,
    title: `${service.name} — ${brandName}`,
    description: `${service.name} with ${phase.practitionerName}`,
    start: phase.slot.start,
    end: phase.slot.end,
    stamp: phase.slot.start,
  });
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

      {/* The pre-arrival ritual (BOOKING_DESIGN.md §3): prep + arrival, practice-authored. */}
      <div className="mt-6 border-t border-border-hairline pt-5">
        <p className="type-kicker">Before you come in</p>
        <ul className="mt-3 flex flex-col gap-2 text-sm text-text-secondary">
          <li>Skip alcohol and blood thinners for 24 hours before your visit.</li>
          <li>Arrive 10 minutes early — check in at the front desk.</li>
        </ul>
      </div>

      <div className="mt-8 flex items-center gap-3">
        <Link
          href="/"
          className="inline-block rounded-control bg-action-primary px-5 py-2 text-sm font-medium text-text-on-accent"
        >
          Back to home
        </Link>
        <a
          href={icsDataUrl(ics)}
          download={`${service.code}.ics`}
          className="inline-block rounded-control border border-border-hairline px-5 py-2 text-sm font-medium text-text-secondary"
        >
          Add to calendar
        </a>
      </div>
    </div>
  );
}
