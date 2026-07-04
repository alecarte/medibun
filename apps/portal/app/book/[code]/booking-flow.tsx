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
import { useEffect, useRef, useState } from "react";

import { Avatar } from "../../components/avatar";
import { buildIcs } from "../../lib/ics";
import {
  dayParts,
  dayStrip,
  formatDuration,
  formatPrice,
  formatSlotFull,
  formatSlotTime,
} from "../../lib/slots";
import { prepNotes } from "../prep";

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
      readonly settled: boolean;
    };

/** Dead-slot key: per schedule, so one practitioner's 409 never hides another's slot. */
const slotKey = (scheduleId: string, start: string) => `${scheduleId}|${start}`;

/** The default selection: the first practitioner with an open time, else the first. */
const firstOpenScheduleId = (practitioners: readonly PractitionerAvailability[]) =>
  (practitioners.find((p) => p.slots.length > 0) ?? practitioners[0])?.scheduleId;

export function BookingFlow({
  service,
  availability,
}: {
  readonly service: ServiceSummary;
  readonly availability: ServiceAvailability;
}) {
  const router = useRouter();
  const { practitioners, timezone } = availability;
  const defaultScheduleId = firstOpenScheduleId(practitioners);
  // Everything is keyed by scheduleId (unique per entry) — a practitioner with two
  // schedules for one service stays two independently bookable columns.
  const [scheduleId, setScheduleId] = useState(defaultScheduleId);
  const [switching, setSwitching] = useState(false);
  const [selectedDayKey, setSelectedDayKey] = useState<string | undefined>();
  const [selected, setSelected] = useState<AvailabilitySlot | undefined>();
  // Slots the server said were taken since this availability was fetched — hidden
  // locally so the patient never re-picks a known-dead time. Reset whenever fresh
  // availability arrives (render-time reset on prop change): server truth wins,
  // and a selection pointing at a schedule the refresh removed is re-defaulted
  // (review fix: a retired schedule must never dead-end the picker).
  const [taken, setTaken] = useState<readonly string[]>([]);
  const [prevAvailability, setPrevAvailability] = useState(availability);
  if (prevAvailability !== availability) {
    setPrevAvailability(availability);
    setTaken([]);
    setSelected(undefined);
    if (!practitioners.some((p) => p.scheduleId === scheduleId)) {
      setScheduleId(defaultScheduleId);
      setSelectedDayKey(undefined);
    }
  }
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [error, setError] = useState<string | undefined>();
  // Focus the error when it appears — the picker re-render drops focus to body
  // otherwise and screen-reader users lose their place (review fix).
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) {
      errorRef.current?.focus();
    }
  }, [error]);

  const practitioner = practitioners.find((p) => p.scheduleId === scheduleId);

  async function book(slot: AvailabilitySlot, chosen: PractitionerAvailability) {
    setError(undefined);
    setPhase({ kind: "booked", slot, practitionerName: chosen.practitionerName, settled: false });
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
    return <ConfirmationCard service={service} phase={phase} timezone={timezone} />;
  }

  const visibleSlots = practitioner
    ? practitioner.slots.filter((s) => !taken.includes(slotKey(practitioner.scheduleId, s.start)))
    : [];
  const strip = dayStrip(visibleSlots, timezone, availability.windowStart, availability.windowDays);
  const activeDay =
    strip.find((d) => d.dayKey === selectedDayKey && d.slots.length > 0) ??
    strip.find((d) => d.slots.length > 0);
  const parts = activeDay ? dayParts(activeDay.slots, timezone) : [];
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
        <p
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="mt-6 text-sm text-status-danger-text outline-none"
        >
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
              const count = day.slots.length;
              return (
                <button
                  key={day.dayKey}
                  type="button"
                  // Availability in the accessible name, not just the visual meter
                  // (review fix: screen readers heard only the date before).
                  aria-label={`${day.dayLabel}, ${
                    count === 0
                      ? "no open times"
                      : `${count} open ${count === 1 ? "time" : "times"}`
                  }`}
                  aria-pressed={active}
                  disabled={count === 0}
                  onClick={() => {
                    setSelectedDayKey(day.dayKey);
                    setSelected(undefined);
                  }}
                  className={`flex-1 rounded-lg border px-1 pt-2 pb-2 text-center ${
                    active
                      ? "border-brand-primary bg-brand-wash"
                      : count === 0
                        ? "border-border-hairline bg-surface-card opacity-45"
                        : "border-border-hairline bg-surface-card"
                  }`}
                >
                  <span
                    className={`block text-xs tracking-wide uppercase ${active ? "text-brand-primary" : "text-text-secondary"}`}
                  >
                    {day.weekday}
                  </span>
                  <span
                    className={`mt-0.5 block text-base font-semibold tabular-nums ${active ? "text-brand-primary" : "text-text-primary"} ${count === 0 ? "line-through decoration-1" : ""}`}
                  >
                    {day.dayOfMonth}
                  </span>
                  {/* Openness meter, only where times exist — an empty day carries no
                      bar (review fix: a full bar on a never-offered day is untruthful
                      scarcity), and the fill is neutral (accent = action/active/focus
                      only, DESIGN.md tenet 2). */}
                  <span
                    aria-hidden
                    className="mx-auto mt-1.5 block h-0.5 w-3/4 overflow-hidden rounded-full bg-surface-well"
                  >
                    {count > 0 && (
                      <span
                        className="block h-full bg-border-interactive"
                        style={{
                          width: `${Math.round((count / Math.max(1, ...strip.map((d) => d.slots.length))) * 100)}%`,
                        }}
                      />
                    )}
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
                          {formatSlotTime(slot.start, timezone)}
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
          {/* Mobile-first: the CTA is a full-width thumb target below sm, then moves
              beside the summary where there's room. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <p className="text-sm text-text-secondary">
              <span className="font-semibold text-text-primary">
                {service.name} with {practitioner.practitionerName}
              </span>{" "}
              · <span className="tabular-nums">{formatSlotFull(selected.start, timezone)}</span>
              <span className="mt-0.5 block text-xs">Reschedule free up to 24 hours before.</span>
            </p>
            <button
              type="button"
              onClick={() => void book(selected, practitioner)}
              className="shrink-0 rounded-control bg-action-primary px-5 py-2.5 text-sm font-medium text-text-on-accent"
            >
              Book {formatSlotTime(selected.start, timezone)}
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
  timezone,
}: {
  readonly service: ServiceSummary;
  readonly phase: Extract<Phase, { kind: "booked" }>;
  readonly timezone: string;
}) {
  // Stable per mount: the UID never changes between downloads of the same visit
  // (calendar apps dedupe by UID — review fix), and DTSTAMP is the real creation
  // instant per RFC 5545, not the future appointment time.
  const [icsHref] = useState(() => {
    const ics = buildIcs({
      id: `${service.code}-${phase.slot.start}`,
      title: `${service.name} — ${tokens["brand-name"]}`,
      description: `${service.name} with ${phase.practitionerName}`,
      start: phase.slot.start,
      end: phase.slot.end,
      stamp: new Date().toISOString(),
    });
    return URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  });
  useEffect(() => () => URL.revokeObjectURL(icsHref), [icsHref]);
  // The picker subtree just unmounted (focus fell to body) — land focus on the
  // outcome so it is announced and keyboard users stay oriented (review fix).
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="animate-confirm max-w-lg rounded-lg border border-border-hairline bg-surface-card p-5 shadow-low sm:p-8">
      <p className="type-kicker">Your visit</p>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="type-display mt-3 text-2xl text-text-primary outline-none"
      >
        Booked for{" "}
        <span className="tabular-nums">{formatSlotFull(phase.slot.start, timezone)}</span>
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

      {/* The pre-arrival ritual (BOOKING_DESIGN.md §3), practice-authored per service. */}
      <div className="mt-6 border-t border-border-hairline pt-5">
        <p className="type-kicker">Before you come in</p>
        <ul className="mt-3 flex flex-col gap-2 text-sm text-text-secondary">
          {prepNotes(service.code).map((note) => (
            <li key={note}>{note}</li>
          ))}
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
          href={icsHref}
          download={`${service.code}.ics`}
          className="inline-block rounded-control border border-border-hairline px-5 py-2 text-sm font-medium text-text-secondary"
        >
          Add to calendar
        </a>
      </div>
    </div>
  );
}
