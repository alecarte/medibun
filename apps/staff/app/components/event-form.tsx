"use client";

import type {
  CreateInternalEventRequest,
  DaySheetPractitioner,
  InternalEventType,
} from "@medibun/api-client";
import { useState } from "react";

import { EVENT_TYPE_LABEL } from "../lib/day-sheet";

/**
 * The "New event" form (S5c): day off / meeting / misc block. Everything is sent
 * practice-local (date + wall times) — the BFF owns timezone math. Titles are NON-PHI
 * BY RULE: they render unmasked under the privacy glance mask, so the form says so.
 */

const TYPES: readonly InternalEventType[] = ["day-off", "meeting", "block"];

const inputClass =
  "rounded-control border border-border-interactive bg-surface-card px-2 py-1 text-sm text-text-primary";

export function EventForm({
  practitioners,
  defaultPractitionerId,
  defaultDate,
  onCreate,
  onClose,
}: {
  practitioners: readonly DaySheetPractitioner[];
  defaultPractitionerId?: string;
  defaultDate: string;
  /** Performs the create; rejects on failure (the form shows the error inline). */
  onCreate: (request: CreateInternalEventRequest) => Promise<void>;
  onClose: () => void;
}) {
  const [type, setType] = useState<InternalEventType>("block");
  const [selected, setSelected] = useState<readonly string[]>(
    defaultPractitionerId
      ? [defaultPractitionerId]
      : practitioners[0]
        ? [practitioners[0].practitionerId]
        : [],
  );
  const [date, setDate] = useState(defaultDate);
  const [startTime, setStartTime] = useState("12:00");
  const [endTime, setEndTime] = useState("13:00");
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function pickType(next: InternalEventType) {
    setType(next);
    // Only meetings span practitioners — collapsing keeps the selection valid.
    if (next !== "meeting" && selected.length > 1) {
      setSelected(selected.slice(0, 1));
    }
  }

  function togglePractitioner(id: string) {
    if (type !== "meeting") {
      setSelected([id]);
      return;
    }
    setSelected((current) =>
      current.includes(id) ? current.filter((p) => p !== id) : [...current, id],
    );
  }

  const timed = type !== "day-off";
  const timesValid = !timed || endTime > startTime;
  const canSubmit = selected.length > 0 && date.length > 0 && timesValid && !pending;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const trimmed = title.trim();
      await onCreate({
        type,
        ...(timed && trimmed ? { title: trimmed } : {}),
        practitionerIds: selected,
        date,
        ...(timed ? { startTime, endTime } : {}),
      });
    } catch {
      setError("Couldn't add the event. Try again.");
      setPending(false);
    }
  }

  return (
    <form
      role="dialog"
      aria-label="New event"
      onSubmit={submit}
      className="flex w-72 flex-col gap-3 rounded-lg border border-border-hairline bg-surface-card p-4 shadow-lg"
    >
      <p className="text-sm font-medium text-text-primary">New event</p>

      <div className="flex gap-1" role="group" aria-label="Event type">
        {TYPES.map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={t === type}
            onClick={() => pickType(t)}
            className={`rounded-control px-2.5 py-1 text-sm ${
              t === type
                ? "bg-brand-wash font-medium text-brand-primary"
                : "border border-border-interactive text-text-primary hover:bg-surface-well"
            }`}
          >
            {EVENT_TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1" role="group" aria-label="Practitioners">
        {practitioners.map((p) => (
          <button
            key={p.practitionerId}
            type="button"
            aria-pressed={selected.includes(p.practitionerId)}
            onClick={() => togglePractitioner(p.practitionerId)}
            className={`rounded-md px-2.5 py-1 text-left text-sm ${
              selected.includes(p.practitionerId)
                ? "bg-brand-wash font-medium text-brand-primary"
                : "text-text-primary hover:bg-surface-well"
            }`}
          >
            {p.practitionerName}
          </button>
        ))}
      </div>

      <label className="flex items-center justify-between gap-2 text-sm text-text-secondary">
        Date
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className={inputClass}
        />
      </label>

      {timed && (
        <>
          <div className="flex items-center gap-2">
            <label className="flex flex-1 items-center justify-between gap-2 text-sm text-text-secondary">
              From
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-1 items-center justify-between gap-2 text-sm text-text-secondary">
              To
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className={inputClass}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm text-text-secondary">
            Title (optional)
            <input
              type="text"
              value={title}
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
              className={inputClass}
            />
            {/* The mask rule, stated where the text is typed (DATA_MODEL.md). */}
            <span className="text-xs text-text-secondary">
              Titles stay visible while the screen is masked — never include patient details.
            </span>
          </label>
        </>
      )}

      {!timesValid && (
        <p className="text-sm text-status-danger-text">End time must be after the start.</p>
      )}
      {error && (
        <p role="status" className="text-sm text-status-danger-text">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-control px-3 py-1.5 text-sm text-text-secondary"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-control bg-action-primary px-3 py-1.5 text-sm font-medium text-text-on-accent disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
    </form>
  );
}
