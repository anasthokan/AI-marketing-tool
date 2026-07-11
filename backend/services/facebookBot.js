import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { saveImage } from "../utils/saveImage.js";
import { createMutex } from "../utils/mutex.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.resolve(__dirname, "..", "facebook-session");
const fbMutex = createMutex();
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const CREATE_POST_SELECTORS = [
  "[aria-label='Create a post']",
  "[aria-label='Create Post']",
  "[aria-label='Create post']",
  "div[role='button'][aria-label*='Create a post']",
  "div[role='button'][aria-label*='Create Post']",
];

const findCreatePost = async (page, timeoutMs = 25000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of CREATE_POST_SELECTORS) {
      const el = await page.$(sel);
      if (el) return el;
    }

    // Fallback: "What's on your mind" composer
    const mind = await page.evaluateHandle(() => {
      const nodes = Array.from(document.querySelectorAll("span, div"));
      return (
        nodes.find((n) => {
          const t = (n.innerText || "").trim().toLowerCase();
          return (
            t.startsWith("what's on your mind") ||
            t.startsWith("whats on your mind") ||
            t.includes("on your mind")
          );
        }) || null
      );
    });
    if (mind && mind.asElement()) return mind.asElement();

    await delay(1000);
  }
  return null;
};

const isLoginPage = async (page) => {
  const loginForm = await page.$(
    "input#email, input[name='email'], input[name='pass']"
  );
  return Boolean(loginForm);
};

/**
 * If not logged in and headed mode: keep Chrome open so user can login on RDP.
 */
const ensureLoggedIn = async (page) => {
  const headed = process.env.PUPPETEER_HEADLESS === "false";
  const loggedInComposer = await findCreatePost(page, 5000);
  if (loggedInComposer) return loggedInComposer;

  const onLogin = await isLoginPage(page);
  if (!onLogin) {
    // Maybe slow load — wait a bit more for composer
    return findCreatePost(page, 20000);
  }

  if (!headed) {
    throw new Error(
      "Facebook not logged in. Set PUPPETEER_HEADLESS=false, restart PM2, schedule a post, login in the open Chrome window (it will wait), then set headless true again."
    );
  }

  const waitMs = Number(process.env.FB_LOGIN_WAIT_MS || 300000); // 5 min
  console.log(
    `Facebook login required. Chrome will stay open for ${Math.round(
      waitMs / 1000
    )}s — login on RDP now...`
  );

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const btn = await findCreatePost(page, 3000);
    if (btn) {
      console.log("Facebook login detected — continuing post.");
      return btn;
    }
    const stillLogin = await isLoginPage(page);
    if (!stillLogin) {
      const btn2 = await findCreatePost(page, 10000);
      if (btn2) return btn2;
    }
    await delay(2000);
  }

  throw new Error(
    "Timed out waiting for Facebook login on server (5 minutes)."
  );
};

const postOnce = async (caption, imageInputs) => {
  let browser = null;
  const imagePaths = [];

  try {
    // Clear stale lock if previous crash left Chrome lock
    const lockFile = path.join(SESSION_DIR, "SingletonLock");
    if (fs.existsSync(lockFile)) {
      try {
        fs.unlinkSync(lockFile);
      } catch {}
    }

    browser = await puppeteer.launch({
      headless: process.env.PUPPETEER_HEADLESS !== "false",
      defaultViewport: { width: 1366, height: 768 },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=1366,768",
      ],
      userDataDir: SESSION_DIR,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    await page.goto("https://www.facebook.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await delay(5000);

    let createBtn = await ensureLoggedIn(page);
    if (!createBtn) {
      const shot = path.resolve(`fb_debug_${Date.now()}.png`);
      try {
        await page.screenshot({ path: shot, fullPage: true });
        console.log("Debug screenshot:", shot);
      } catch {}
      throw new Error(
        "Could not find Facebook 'Create a post' after login wait."
      );
    }

    await createBtn.click();
    console.log("Post box opened");
    await delay(4000);

    const textbox = await page.waitForSelector(
      "[role='dialog'] div[role='textbox'], div[role='textbox']",
      { visible: true, timeout: 20000 }
    );
    await textbox.click();
    await page.keyboard.type(caption, { delay: 15 });
    console.log("Caption added");
    await delay(2000);

    if (imageInputs && imageInputs.length > 0) {
      for (let i = 0; i < imageInputs.length; i++) {
        const imgPath = path.resolve(`fb_${Date.now()}_${i}.png`);
        const saved = await saveImage(imageInputs[i], imgPath);
        if (saved) imagePaths.push(imgPath);
      }

      if (imagePaths.length === 0) {
        throw new Error("Failed to prepare any Facebook images");
      }

      let fileInput = await page.$("[role='dialog'] input[type='file']");
      if (!fileInput) {
        await page.evaluate(() => {
          const dialog = document.querySelector("[role='dialog']");
          if (!dialog) return;
          let input = dialog.querySelector("input[type='file']");
          if (!input) {
            input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";
            input.multiple = true;
            input.style.display = "none";
            dialog.appendChild(input);
          }
        });
        fileInput = await page.$("[role='dialog'] input[type='file']");
      }

      if (!fileInput) throw new Error("Facebook file input not found");
      await fileInput.uploadFile(...imagePaths);
      console.log("Images uploaded");
      await delay(5000);
    }

    const postBtn = await page.waitForSelector(
      "[role='dialog'] [aria-label='Post'], [role='dialog'] [aria-label='Post'] div, [role='dialog'] div[aria-label='Post']",
      { visible: true, timeout: 20000 }
    );

    const isDisabled = await page.evaluate(
      (btn) => btn.getAttribute("aria-disabled") === "true",
      postBtn
    );
    if (isDisabled) throw new Error("Post button is disabled");

    await postBtn.click({ delay: 100 });
    console.log("Post clicked");

    await page.waitForFunction(() => !document.querySelector("[role='dialog']"), {
      timeout: 90000,
    });

    console.log("Facebook post done");
    await delay(3000);
    return { success: true };
  } catch (err) {
    console.log("ERROR:", err.message);
    return { success: false, error: err.message };
  } finally {
    for (const file of imagePaths) {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    // Let Chrome release profile lock
    await delay(3000);
  }
};

export const postToFacebookBot = (caption, imageInputs) =>
  fbMutex.run(() => postOnce(caption, imageInputs));
