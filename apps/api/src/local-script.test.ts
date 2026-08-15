import { afterEach, describe, expect, it, vi } from "vitest";

import { runLocalScript } from "./local-script.js";
import { makeErrorLine, UsageError } from "./ingest/import-cli.js";

/**
 * The shared composition root's failure posture, pinned now that it is one function:
 * whatever a CLI body throws, the terminal sees the CLI's own scrubbed `errorLine` and
 * never the raw error — a driver failure's message embeds the failed query and its
 * bound parameters.
 */

const LEAKY = "Zzyzxine Quibbleworth";

const errorLine = makeErrorLine([UsageError], "command failed");

const spies = () => ({
  error: vi.spyOn(console, "error").mockImplementation(() => {}),
  exit: vi.spyOn(process, "exit").mockImplementation(() => undefined as never),
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runLocalScript", () => {
  it("refuses to start without EXPERIENCE_DATABASE_URL, and says how to fix it", async () => {
    vi.stubEnv("EXPERIENCE_DATABASE_URL", "");
    const { error, exit } = spies();

    await runLocalScript({ run: () => Promise.resolve(), errorLine });

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]![0]).toContain("EXPERIENCE_DATABASE_URL unset");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("prints only the scrubbed errorLine when the CLI body throws a driver-shaped error", async () => {
    vi.stubEnv("EXPERIENCE_DATABASE_URL", "postgres://local/experience");
    const { error, exit } = spies();
    // The hazard this posture guards: drizzle wraps a failed query as
    // "Failed query: <sql> params: <bound values>" — staged names included.
    const driverError = Object.assign(new Error(`Failed query: insert params: ${LEAKY}`), {
      code: "42703",
    });

    await runLocalScript({ run: () => Promise.reject(driverError), errorLine });

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]![0]).toBe("command failed: Error (42703)");
    expect(error.mock.calls[0]![0]).not.toContain(LEAKY);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits quietly when the CLI body succeeds", async () => {
    vi.stubEnv("EXPERIENCE_DATABASE_URL", "postgres://local/experience");
    const { error, exit } = spies();

    await runLocalScript({ run: () => Promise.resolve(), errorLine });

    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
