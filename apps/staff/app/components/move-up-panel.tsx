"use client";

import type { ApiClient, MoveUpEntry, MoveUpResolution } from "@medibun/api-client";
import { useEffect, useState } from "react";

import { formatBookedAt } from "../lib/day-sheet";
import { maskName, maskValue } from "../lib/privacy";

/**
 * The move-up panel (S5.7): the desk-worked cancellation-backfill waitlist, oldest
 * first (fairness). The desk calls the patient (no SMS/push in v0), moves their
 * existing appointment earlier with the normal reschedule tools, then marks the entry
 * fulfilled here. Names/phones arrive live from the BFF (resolved from FHIR as the
 * caller) and honor the privacy glance mask like every other patient field.
 */
export function MoveUpPanel({
  api,
  timezone,
  masked,
  onClose,
}: {
  api: Pick<ApiClient, "listMoveUp" | "resolveMoveUp">;
  timezone: string;
  masked: boolean;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<MoveUpEntry[] | undefined>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .listMoveUp()
      .then((list) => {
        if (alive) {
          setEntries(list);
        }
      })
      .catch(() => {
        if (alive) {
          setFailed(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [api]);

  async function resolve(entry: MoveUpEntry, resolution: MoveUpResolution) {
    // Optimistic removal; a failed write puts the row back IN ORDER — the list
    // promises oldest-first, so the reinsert re-sorts by createdAt.
    setEntries((list) => list?.filter((e) => e.id !== entry.id));
    try {
      await api.resolveMoveUp(entry.id, resolution);
    } catch {
      setEntries((list) =>
        list ? [...list, entry].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : list,
      );
    }
  }

  const displayName = (name: string) => (masked ? maskName(name) : name);

  return (
    <div className="flex w-80 flex-col rounded-lg border border-border-hairline bg-surface-card p-3 shadow-lg md:w-96">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-text-primary">Move-up list</p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-control px-2 py-0.5 text-sm text-text-secondary"
        >
          Close
        </button>
      </div>
      <p className="mt-0.5 text-xs text-text-secondary">
        Oldest first. Call when time frees up, move their appointment, then mark it fulfilled.
      </p>

      {failed && (
        <p className="mt-3 text-sm text-status-warning-text">
          Couldn&apos;t load the list. Close and try again.
        </p>
      )}
      {!failed && entries === undefined && (
        <p className="mt-3 text-sm text-text-secondary">Loading…</p>
      )}
      {entries !== undefined && entries.length === 0 && (
        <p className="mt-3 text-sm text-text-secondary">No one is waiting for an earlier time.</p>
      )}

      {entries !== undefined && entries.length > 0 && (
        <ul className="mt-2 flex max-h-80 flex-col gap-1 overflow-y-auto">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded-md border border-border-hairline px-2.5 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium text-text-primary">
                  {displayName(entry.patientName)}
                </span>
                <span className="shrink-0 text-xs text-text-secondary tabular-nums">
                  {maskValue(masked, entry.patientPhone) ?? "—"}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-text-secondary">
                {entry.serviceName ?? entry.serviceCode}
                {entry.appointmentStart
                  ? ` · holds ${formatBookedAt(entry.appointmentStart, timezone)}`
                  : ""}
              </p>
              <p className="text-xs text-text-secondary">
                {entry.practitionerName ?? "Any provider"}
                {entry.note ? ` · ${entry.note}` : ""}
              </p>
              <div className="mt-1.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => void resolve(entry, "fulfilled")}
                  className="rounded-control border border-border-interactive px-2 py-0.5 text-xs text-text-primary hover:bg-surface-well"
                >
                  Fulfilled
                </button>
                <button
                  type="button"
                  onClick={() => void resolve(entry, "removed")}
                  className="rounded-control px-2 py-0.5 text-xs text-text-secondary hover:bg-surface-well"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
