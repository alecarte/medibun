import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LoginForm } from "./login-form";
import { stubFetch } from "../lib/stub-fetch";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

describe("login form", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
    refresh.mockClear();
  });

  it("renders labeled email and password fields", () => {
    render(<LoginForm />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("posts to the same-origin /api proxy and navigates to the account on success", async () => {
    const calls = stubFetch(200, { sessionToken: "s-1" });
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "synthia@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "synth-pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("button");
    expect(calls[0]!.url).toBe("/api/auth/login");
    expect(push).toHaveBeenCalledWith("/account");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows friendly copy for bad credentials and never echoes what was typed", async () => {
    stubFetch(401, { error: "invalid_credentials", requestId: "r" });
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "secret@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("button");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That email or password didn't match.");
    expect(alert.textContent).not.toMatch(/secret@example\.test|hunter2/);
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the rate-limit copy on 429", async () => {
    stubFetch(429, { error: "rate_limited", requestId: "r" });
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("button");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many attempts/);
  });
});
