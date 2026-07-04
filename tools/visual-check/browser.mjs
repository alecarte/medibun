// Shared Chromium resolution for visual-check scripts (playwright-core downloads no
// browser). Resolution order: VISUAL_CHECK_CHROMIUM env var → a Playwright-managed
// install under PLAYWRIGHT_BROWSERS_PATH or /opt/pw-browsers (Claude Code remote
// containers) → the system Chrome channel (typical laptop).
import { readdirSync } from "node:fs";
import { chromium } from "playwright-core";

function managedChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  try {
    const dir = readdirSync(root).find((d) => d.startsWith("chromium-"));
    return dir ? `${root}/${dir}/chrome-linux/chrome` : undefined;
  } catch {
    return undefined;
  }
}

export function launch() {
  const executablePath = process.env.VISUAL_CHECK_CHROMIUM ?? managedChromium();
  return chromium.launch(executablePath ? { executablePath } : { channel: "chrome" });
}
