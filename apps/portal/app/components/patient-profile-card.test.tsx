import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PatientProfileCard } from "./patient-profile-card";

describe("PatientProfileCard", () => {
  it("renders the patient's name and id", () => {
    render(<PatientProfileCard profile={{ id: "synth-1", name: "Synth Example" }} />);
    expect(screen.getByRole("heading", { name: "Synth Example" })).toBeInTheDocument();
    expect(screen.getByText(/synth-1/)).toBeInTheDocument();
  });

  it("shows the birth date when present", () => {
    render(
      <PatientProfileCard
        profile={{ id: "synth-1", name: "Synth Example", birthDate: "1990-01-01" }}
      />,
    );
    expect(screen.getByText(/1990-01-01/)).toBeInTheDocument();
  });

  it("omits the birth date row when absent", () => {
    render(<PatientProfileCard profile={{ id: "synth-1", name: "Synth Example" }} />);
    expect(screen.queryByText(/birth/i)).not.toBeInTheDocument();
  });
});
