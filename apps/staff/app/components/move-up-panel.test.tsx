import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { MoveUpEntry } from "@medibun/api-client";

import { MoveUpPanel } from "./move-up-panel";

const entries: MoveUpEntry[] = [
  {
    id: "m1",
    patientId: "pt1",
    patientName: "Synthia Loginsmith",
    patientPhone: "555-010-0100",
    appointmentId: "a1",
    appointmentStart: "2026-07-16T18:00:00.000Z",
    serviceCode: "svc-botox",
    serviceName: "Botox",
    practitionerId: "pr1",
    practitionerName: "Riley Reyes",
    note: "mornings only",
    createdAt: "2026-07-09T12:00:00.000Z",
  },
  {
    id: "m2",
    patientId: "pt2",
    patientName: "Jo Park",
    appointmentId: "a2",
    serviceCode: "svc-lip-filler",
    createdAt: "2026-07-09T13:00:00.000Z",
  },
];

function makeApi(overrides?: {
  listMoveUp?: () => Promise<MoveUpEntry[]>;
  resolveMoveUp?: (entryId: string, resolution: "fulfilled" | "removed") => Promise<void>;
}) {
  return {
    listMoveUp: overrides?.listMoveUp ?? (() => Promise.resolve(entries)),
    resolveMoveUp: overrides?.resolveMoveUp ?? (() => Promise.resolve()),
  };
}

const props = { timezone: "America/New_York", masked: false, onClose: vi.fn() };

describe("MoveUpPanel", () => {
  it("lists waiting entries with live-resolved details, oldest first", async () => {
    render(<MoveUpPanel api={makeApi()} {...props} />);
    expect(await screen.findByText("Synthia Loginsmith")).toBeInTheDocument();
    expect(screen.getByText("555-010-0100")).toBeInTheDocument();
    expect(screen.getByText(/Botox · holds/)).toBeInTheDocument();
    expect(screen.getByText(/Riley Reyes · mornings only/)).toBeInTheDocument();
    // Absent preference reads honestly as any provider; absent phone keeps its dash.
    expect(screen.getByText("Any provider")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(within(items[0]!).getByText("Synthia Loginsmith")).toBeInTheDocument();
  });

  it("honors the privacy glance mask: initials, hidden phone", async () => {
    render(<MoveUpPanel api={makeApi()} {...props} masked />);
    expect(await screen.findByText("S. L.")).toBeInTheDocument();
    expect(screen.queryByText("Synthia Loginsmith")).not.toBeInTheDocument();
    expect(screen.queryByText("555-010-0100")).not.toBeInTheDocument();
    expect(screen.getByText("Hidden")).toBeInTheDocument();
  });

  it("marks an entry fulfilled: optimistic removal + PATCH", async () => {
    const resolveMoveUp = vi.fn(() => Promise.resolve());
    render(<MoveUpPanel api={makeApi({ resolveMoveUp })} {...props} />);
    const row = (await screen.findByText("Synthia Loginsmith")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Fulfilled" }));
    expect(screen.queryByText("Synthia Loginsmith")).not.toBeInTheDocument();
    expect(resolveMoveUp).toHaveBeenCalledWith("m1", "fulfilled");
  });

  it("puts the row back when the resolution write fails", async () => {
    const resolveMoveUp = vi.fn(() => Promise.reject(new Error("down")));
    render(<MoveUpPanel api={makeApi({ resolveMoveUp })} {...props} />);
    const row = (await screen.findByText("Synthia Loginsmith")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Synthia Loginsmith")).toBeInTheDocument();
  });

  it("shows the empty state and the load-failure state", async () => {
    const { unmount } = render(
      <MoveUpPanel api={makeApi({ listMoveUp: () => Promise.resolve([]) })} {...props} />,
    );
    expect(await screen.findByText("No one is waiting for an earlier time.")).toBeInTheDocument();
    unmount();
    render(
      <MoveUpPanel
        api={makeApi({ listMoveUp: () => Promise.reject(new Error("down")) })}
        {...props}
      />,
    );
    expect(await screen.findByText(/Couldn't load the list/)).toBeInTheDocument();
  });
});
