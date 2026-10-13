import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const puppeteer = require("puppeteer-core");

const videoPath = "/Users/benjaminsloutsky/Downloads/Homemade Sea Salt - Nick DiGiovanni (1080p).mp4";
const sizes = [];

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: false,
  protocolTimeout: 300000,
  args: ["--no-sandbox", "--disable-gpu", "--use-fake-ui-for-media-stream"],
});
const page = await browser.newPage();
page.setDefaultTimeout(300000);
page.on("request", (req) => {
  const url = req.url();
  if (!url.includes("/api/")) return;
  const post = req.postData();
  sizes.push({
    url: url.replace(/^https?:\/\/[^/]+/, ""),
    method: req.method(),
    bytes: post ? Buffer.byteLength(post) : 0,
  });
});
page.on("response", (res) => {
  const url = res.url();
  if (!url.includes("/api/")) return;
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const req = [...sizes].reverse().find((item) => item.url.split("?")[0] === path && item.status === undefined);
  if (req) req.status = res.status();
});

const baseUrl = process.env.E2E_BASE_URL || "http://localhost:3000";
await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.deleteDatabase("shorts-analyzer");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    }),
);
await page.reload({ waitUntil: "networkidle0" });
const input = await page.$("input[type=file]");
if (!input) throw new Error("file input missing");
await input.uploadFile(videoPath);
await page.waitForFunction(() => {
  const btn = [...document.querySelectorAll("button")].find((el) =>
    /Analyze Video|View previous|Analyzing/i.test(el.textContent || ""),
  );
  return btn && !btn.disabled;
}, { timeout: 30000 });
const navigated = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 180000 }).catch(() => null);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((el) => /Analyze Video/i.test(el.textContent || ""));
  btn?.click();
});
await Promise.race([
  navigated,
  page.waitForFunction(
    () => /HTTP |failed|too large|413|Could not/i.test(document.body.innerText),
    { timeout: 180000 },
  ).catch(() => null),
]);
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 30000 }).catch(() => undefined);
const snapshot = await page.evaluate(() => ({
  url: location.href,
  text: document.body.innerText.slice(0, 4500),
}));
console.log(JSON.stringify({ snapshot, sizes }, null, 2));
await browser.close();
if (!snapshot.url.includes("/analysis")) process.exit(1);
const over = sizes.filter((item) => item.bytes > 4_500_000 || item.status === 413);
if (over.length) {
  console.error("OVERSIZE", over);
  process.exit(2);
}
