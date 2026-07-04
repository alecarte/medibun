// Quick screenshot CLI for simple cases (flows with clicks get their own script —
// see README). Usage:
//   node shoot.mjs <url> <out.png> [WxH] [--signed-in] [--collapsed]
import { launch } from "./browser.mjs";

const [url, out, size, ...flags] = process.argv.slice(2);
if (!url || !out) {
  console.error("usage: node shoot.mjs <url> <out.png> [WxH] [--signed-in] [--collapsed]");
  process.exit(1);
}
const [width, height] = (size ?? "1280x800").split("x").map(Number);

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width, height } });
const cookies = [];
if (flags.includes("--signed-in")) {
  cookies.push({ name: "medibun_session", value: "stub-session", url });
}
if (flags.includes("--collapsed")) {
  cookies.push({ name: "medibun_sidebar", value: "1", url });
}
if (cookies.length) {
  await ctx.addCookies(cookies);
}
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "networkidle" });
await page.screenshot({ path: out, fullPage: flags.includes("--full") });
await browser.close();
console.log(`wrote ${out}`);
