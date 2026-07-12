/**
 * Run this DIRECTLY in RDP PowerShell (NOT via PM2 / Jenkins schedule).
 * Chrome stays open until you finish LinkedIn login.
 *
 *   cd C:\inetpub\wwwroot\ai-marketing-backend
 *   node scripts/linkedinLogin.js
 */
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.resolve(__dirname, "..", "linkedin-session");
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
  const login = await page.$(
    "input#username, input[name='session_key'], input#password, input[name='session_password']"
  );
  if (login) return false;

  const url = page.url();
  if (
    url.includes("/login") ||
    url.includes("/uas/login") ||
    url.includes("/checkpoint")
  ) {
    return false;
  }

  const markers = [
    "button.share-box-feed-entry__trigger",
    "[aria-label='Start a post']",
    ".global-nav__me",
    "[data-control-name='nav.settings_and_privacy']",
    "img.global-nav__me-photo",
  ];
  for (const sel of markers) {
    if (await page.$(sel)) return true;
  }

  const byText = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("button, span"));
    return nodes.some((n) => {
      const t = (n.innerText || "").trim().toLowerCase();
      return t === "start a post" || t.startsWith("start a post");
    });
  });
  return byText;
};

const lock = path.join(SESSION_DIR, "SingletonLock");
if (fs.existsSync(lock)) {
  try {
    fs.unlinkSync(lock);
  } catch {}
}

console.log("Session folder:", SESSION_DIR);
console.log("Opening Chrome — login to LinkedIn, then come back here...");

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ["--start-maximized", "--no-sandbox", "--disable-setuid-sandbox"],
  userDataDir: SESSION_DIR,
});

const page = await browser.newPage();
await page.goto("https://www.linkedin.com/login", {
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
  console.log("LOGIN OK — LinkedIn session saved.");
  console.log("Press Enter to close Chrome...");
  await waitEnter("");
} else {
  console.log("Still not logged in after 15 minutes.");
  console.log("Press Enter to close Chrome...");
  await waitEnter("");
}

await browser.close();
console.log("Done. Keep PUPPETEER_HEADLESS=true for normal posting.");
process.exit(ok ? 0 : 1);
