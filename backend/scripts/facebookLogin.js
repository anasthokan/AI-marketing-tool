/**
 * Run this DIRECTLY in RDP PowerShell (NOT via PM2 / Jenkins schedule).
 * Chrome stays open until you finish Facebook login.
 *
 *   cd C:\inetpub\wwwroot\ai-marketing-backend
 *   node scripts/facebookLogin.js
 */
import puppeteer from "puppeteer";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import {
  prepareBrowserProfile,
  useSinglePage,
  closeBrowserHard,
  resolveChromeLaunch,
} from "../utils/browserSession.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.resolve(__dirname, "..", "facebook-session");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const waitEnter = (msg) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(msg, () => {
      rl.close();
      resolve();
    });
  });

const isLoggedIn = async (page) => {
  try {
    if (page.isClosed()) return false;

    const safeHas = async (selector) => {
      try {
        return Boolean(await page.$(selector));
      } catch {
        return false;
      }
    };

    if (
      (await safeHas("input#email")) ||
      (await safeHas("input[name='email']")) ||
      (await safeHas("input[name='pass']"))
    ) {
      return false;
    }

    const markers = [
      "[aria-label='Create a post']",
      "[aria-label='Create Post']",
      "[aria-label='Create post']",
      "[aria-placeholder*='on your mind']",
      "[aria-label='Your profile']",
      "[aria-label='Account']",
      "[aria-label='Facebook']",
    ];
    for (const sel of markers) {
      if (await safeHas(sel)) return true;
    }
    return false;
  } catch {
    return false;
  }
};

prepareBrowserProfile(SESSION_DIR);

const chrome = resolveChromeLaunch();
console.log("Session folder:", SESSION_DIR);
console.log(
  `Opening ${chrome.label}${chrome.executablePath ? ` @ ${chrome.executablePath}` : ""} — login to Facebook, then come back here...`
);

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: [
    "--start-maximized",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-restore-session-state",
  ],
  userDataDir: SESSION_DIR,
  ...chrome.options,
});

const page = await useSinglePage(browser);
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});
await page.goto("https://www.facebook.com/", {
  waitUntil: "domcontentloaded",
  timeout: 120000,
});

const maxMs = 15 * 60 * 1000;
const start = Date.now();
let ok = false;

while (Date.now() - start < maxMs) {
  if (await isLoggedIn(page)) {
    ok = true;
    break;
  }
  process.stdout.write(".");
  await delay(3000);
}

console.log("");

if (ok) {
  console.log("LOGIN OK — session saved.");
  console.log("Press Enter to close Chrome...");
  await waitEnter("");
} else {
  console.log("Still not logged in after 15 minutes.");
  console.log("Press Enter to close Chrome...");
  await waitEnter("");
}

await closeBrowserHard(browser, SESSION_DIR);
console.log("Done. Keep PUPPETEER_HEADLESS=true for normal posting.");
process.exit(ok ? 0 : 1);
