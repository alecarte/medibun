import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { EventForm } from "./event-form";

const practitioners = [
  { practitionerId: "pr1", practitionerName: "Riley Reyes" },
  { practitionerId: "pr2", practitionerName: "Maya Chen" },
];

const renderForm = (overrides?: Partial<Parameters<typeof EventForm>[0]>) => {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  render(
    <EventForm
      practitioners={practitioners}
      defaultPractitionerId="pr1"
      defaultDate="2026-07-06"
      onCreate={onCreate}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
  return onCreate;
};

describe("EventForm", () => {
  it("submits a block with practice-local date and times", () => {
    const onCreate = renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onCreate).toHaveBeenCalledWith({
      type: "block",
      practitionerIds: ["pr1"],
      date: "2026-07-06",
      startTime: "12:00",
      endTime: "13:00",
    });
  });

  it("All day replaces the times — PTO is a titled all-day block, not a category", () => {
    const onCreate = renderForm();
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "PTO" } });
    fireEvent.click(screen.getByLabelText("All day"));
    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onCreate).toHaveBeenCalledWith({
      type: "block",
      title: "PTO",
      practitionerIds: ["pr1"],
      date: "2026-07-06",
      allDay: true,
    });
  });

  it("half-days are just times — no all-day requirement for time off", () => {
    const onCreate = renderForm();
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "PTO — afternoon" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "13:00" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "17:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onCreate).toHaveBeenCalledWith({
      type: "block",
      title: "PTO — afternoon",
      practitionerIds: ["pr1"],
      date: "2026-07-06",
      startTime: "13:00",
      endTime: "17:00",
    });
  });

  it("explains itself instead of dead-ending when no practitioner has a schedule (regression)", () => {
    // An unseeded stack has no schedules → no practitioners. The old form rendered an
    // empty picker and a permanently greyed Add with no explanation.
    renderForm({ practitioners: [], defaultPractitionerId: undefined });
    expect(screen.getByText(/No practitioner schedules yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("says why Add is disabled when a meeting has no practitioners picked", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Meeting" }));
    // Deselect the only picked practitioner.
    fireEvent.click(screen.getByRole("button", { name: "Riley Reyes" }));
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(screen.getByText("Pick at least one practitioner.")).toBeInTheDocument();
  });

  it("says why Add is disabled when the end time is not after the start", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "11:00" } });
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(screen.getByText("End time must be after the start.")).toBeInTheDocument();
  });
});
