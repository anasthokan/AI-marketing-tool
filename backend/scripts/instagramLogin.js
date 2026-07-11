/**
 * Run this DIRECTLY in RDP PowerShell (NOT via PM2 / Jenkins schedule).
 * Chrome stays open until you finish Instagram login.
 *
 *   cd C:\inetpub\wwwroot\ai-marketing-backend
 *   node scripts/instagramLogin.js
 */
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.resolve(__dirname, "..", "instagram-session");
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
  // Login form still visible?
  const loginUser = await page.$(
    'input[name="username"], input[aria-label="Phone number, username, or email"]'
  );
  const loginPass = await page.$('input[name="password"], input[aria-label="Password"]');
  if (loginUser && loginPass) return false;

  const markers = [
    "svg[aria-label='New post']",
    "svg[aria-label='Home']",
    "svg[aria-label='Search']",
    "svg[aria-label='Reels']",
    "a[href='/']",
  ];
  for (const sel of markers) {
    if (await page.$(sel)) return true;
  }

  // URL left login pages
  const url = page.url();
  if (
    url.includes("/accounts/login") ||
    url.includes("/accounts/emailsignup")
  ) {
    return false;
  }

  return false;
};

const lock = path.join(SESSION_DIR, "SingletonLock");
if (fs.existsSync(lock)) {
  try {
    fs.unlinkSync(lock);
  } catch {}
}

console.log("Session folder:", SESSION_DIR);
console.log("Opening Chrome — login to Instagram, then come back here...");

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ["--start-maximized", "--no-sandbox", "--disable-setuid-sandbox"],
  userDataDir: SESSION_DIR,
});

const page = await browser.newPage();
await page.goto("https://www.instagram.com/accounts/login/", {
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
  console.log("LOGIN OK — Instagram session saved.");
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
