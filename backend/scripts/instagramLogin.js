/**
 * Run this DIRECTLY in RDP PowerShell (NOT via PM2 / Jenkins schedule).
 * Edge stays open until you finish Instagram login.
 *
 *   cd C:\inetpub\wwwroot\ai-marketing-backend
 *   node scripts/instagramLogin.js
 */
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { resolveIgBrowserLaunch, assertEdgeProcess } from "../utils/igBrowser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.resolve(__dirname, "..", "instagram-session-edge");
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

const safeHas = async (page, selector) => {
  try {
    if (page.isClosed()) return false;
    return Boolean(await page.$(selector));
  } catch {
    // Navigation mid-query is normal during Instagram login
    return false;
  }
};

const isLoggedIn = async (page) => {
  try {
    if (page.isClosed()) return false;

    const url = page.url();
    if (
      url.includes("/accounts/login") ||
      url.includes("/accounts/emailsignup") ||
      url.includes("/challenge")
    ) {
      // Still on auth flow — unless home chrome already visible
    }

    const loginUser = await safeHas(
      page,
      'input[name="username"], input[aria-label="Phone number, username, or email"]'
    );
    const loginPass = await safeHas(
      page,
      'input[name="password"], input[aria-label="Password"]'
    );
    if (loginUser && loginPass) return false;

    const markers = [
      "svg[aria-label='New post']",
      "svg[aria-label='Home']",
      "svg[aria-label='Search']",
      "svg[aria-label='Reels']",
      "svg[aria-label='Messenger']",
      "a[href='/direct/inbox/']",
    ];
    for (const sel of markers) {
      if (await safeHas(page, sel)) return true;
    }

    // Logged-in home often has no /accounts/login in URL
    if (
      (url === "https://www.instagram.com/" ||
        url.startsWith("https://www.instagram.com/?") ||
        url.includes("instagram.com/#")) &&
      !loginUser
    ) {
      // Weak signal — wait for a nav icon next loop
      return false;
    }

    return false;
  } catch {
    return false;
  }
};

const lock = path.join(SESSION_DIR, "SingletonLock");
if (fs.existsSync(lock)) {
  try {
    fs.unlinkSync(lock);
  } catch {}
}

const { label, executablePath, options: browserOpts } = resolveIgBrowserLaunch();
console.log("Session folder:", SESSION_DIR);
console.log(
  `Opening ${label}${executablePath ? ` @ ${executablePath}` : ""} — login to Instagram, then come back here...`
);
console.log("(Dots mean waiting. Ignore brief page reloads while you login.)");
console.log("NOTE: Edge looks similar to Chrome — Task Manager me msedge.exe dikhna chahiye.");

const browser = await puppeteer.launch({
  headless: false,
  ...browserOpts,
  defaultViewport: null,
  args: ["--start-maximized", "--no-sandbox", "--disable-setuid-sandbox"],
  userDataDir: SESSION_DIR,
});
assertEdgeProcess(browser);

const page = await browser.newPage();
await page.setUserAgent(
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0"
);

// Don't crash the script when Instagram navigates during login
page.setDefaultNavigationTimeout(120000);
page.on("framenavigated", () => {
  // no-op; just avoid unhandled noise
});

try {
  await page.goto("https://www.instagram.com/accounts/login/", {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
} catch (err) {
  console.log("Initial navigation warning:", err.message);
}

const maxMs = 15 * 60 * 1000;
const start = Date.now();
let ok = false;

while (Date.now() - start < maxMs) {
  try {
    if (await isLoggedIn(page)) {
      ok = true;
      break;
    }
  } catch {
    // keep waiting through navigations
  }
  process.stdout.write(".");
  await delay(3000);
}

console.log("");

if (ok) {
  console.log("LOGIN OK — Instagram session saved (Edge).");
} else {
  console.log("Still not logged in after 15 minutes.");
}

console.log("Press Enter to close browser...");
await waitEnter("");

try {
  await browser.close();
} catch {}

console.log("Done. Keep PUPPETEER_HEADLESS=true for normal posting.");
process.exit(ok ? 0 : 1);
