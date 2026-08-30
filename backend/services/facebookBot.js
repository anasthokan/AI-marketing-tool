import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { saveImage } from "../utils/saveImage.js";
import { isVideoMedia, saveMediaFile, resolveUploadPath } from "../utils/media.js";
import { createMutex } from "../utils/mutex.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.resolve(__dirname, "..", "facebook-session");
const fbMutex = createMutex();
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const isHeaded = () => {
  const v = String(process.env.PUPPETEER_HEADLESS ?? "true")
    .trim()
    .toLowerCase();
  return v === "false" || v === "0" || v === "no";
};

const VIEWPORT = { width: 1400, height: 900 };
const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--window-size=1400,1000",
  "--window-position=0,0",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
  "--disable-infobars",
  "--noerrdialogs",
];

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
  const headed = isHeaded();
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

  const waitMs = Number(process.env.FB_LOGIN_WAIT_MS || 600000); // 10 min
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

/** Click Post even if the footer is below the taskbar / off-screen. */
const clickFacebookPostButton = async (page) => {
  for (let i = 0; i < 15; i++) {
    const result = await page.evaluate(() => {
      const dialog = document.querySelector("[role='dialog']");
      if (!dialog) return "no-dialog";

      dialog.scrollTop = dialog.scrollHeight;
      const scrollables = dialog.querySelectorAll("div");
      for (const el of scrollables) {
        if (el.scrollHeight > el.clientHeight + 40) {
          el.scrollTop = el.scrollHeight;
        }
      }

      const nodes = Array.from(
        dialog.querySelectorAll("[role='button'], button, div[aria-label='Post']")
      );
      const matches = nodes.filter((el) => {
        const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
        const text = (el.innerText || "").trim().toLowerCase();
        return aria === "post" || text === "post";
      });
      if (!matches.length) return "missing";

      const btn = matches[matches.length - 1];
      if (btn.getAttribute("aria-disabled") === "true") return "disabled";

      btn.scrollIntoView({ block: "center", inline: "nearest" });
      btn.click();
      return "clicked";
    });

    console.log("Facebook Post button:", result);
    if (result === "clicked") return true;
    if (result === "no-dialog") return false;
    await delay(2000);
  }
  return false;
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
      headless: !isHeaded(),
      defaultViewport: VIEWPORT,
      args: CHROME_ARGS,
      userDataDir: SESSION_DIR,
    });

    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    await page.goto("https://www.facebook.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await delay(2000);
    try {
      await page.keyboard.press("Escape");
    } catch {}
    await delay(3000);

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
      const videoPost = imageInputs.some(isVideoMedia);

      for (let i = 0; i < imageInputs.length; i++) {
        if (isVideoMedia(imageInputs[i])) {
          const existing = resolveUploadPath(imageInputs[i]);
          if (existing) {
            imagePaths.push(existing);
          } else {
            const vidPath = path.resolve(`fb_${Date.now()}_${i}.mp4`);
            const saved = await saveMediaFile(imageInputs[i], vidPath);
            if (saved) imagePaths.push(saved);
          }
        } else {
          const imgPath = path.resolve(`fb_${Date.now()}_${i}.png`);
          const saved = await saveImage(imageInputs[i], imgPath);
          if (saved) imagePaths.push(imgPath);
        }
      }

      if (imagePaths.length === 0) {
        throw new Error("Failed to prepare any Facebook media");
      }

      await page.evaluate(() => {
        const dialog = document.querySelector("[role='dialog']");
        if (!dialog) return;
        const nodes = Array.from(
          dialog.querySelectorAll("[aria-label], div[role='button'], span")
        );
        for (const el of nodes) {
          const aria = (el.getAttribute("aria-label") || "").toLowerCase();
          const text = (el.innerText || "").trim().toLowerCase();
          if (
            aria.includes("photo/video") ||
            aria.includes("photo / video") ||
            text === "photo/video" ||
            text.includes("photo/video")
          ) {
            (el.closest("[role='button']") || el).click();
            return;
          }
        }
      });
      await delay(2000);

      const fileInputs = await page.$$("[role='dialog'] input[type='file']");
      let fileInput = null;
      for (const input of fileInputs) {
        const accept = await page.evaluate((el) => el.accept || "", input);
        if (videoPost && /video/i.test(accept)) {
          fileInput = input;
          break;
        }
        if (!fileInput) fileInput = input;
      }

      if (!fileInput) {
        await page.evaluate((accept) => {
          const dialog = document.querySelector("[role='dialog']");
          if (!dialog) return;
          let input = dialog.querySelector("input[type='file']");
          if (!input) {
            input = document.createElement("input");
            input.type = "file";
            input.multiple = true;
            input.style.display = "none";
            dialog.appendChild(input);
          }
          input.accept = accept;
        }, videoPost ? "video/mp4,video/*,image/*" : "image/*");
        fileInput = await page.$("[role='dialog'] input[type='file']");
      } else if (videoPost) {
        await page.evaluate((el) => {
          el.accept = "video/mp4,video/*,image/*";
        }, fileInput);
      }

      if (!fileInput) throw new Error("Facebook file input not found");
      await fileInput.uploadFile(
        ...(videoPost ? imagePaths.slice(0, 1) : imagePaths)
      );
      console.log(videoPost ? "Video uploaded" : "Images uploaded");

      const readyTimeout = videoPost ? 180000 : 25000;
      await page.waitForFunction(
        (isVideo) => {
          const dialog = document.querySelector("[role='dialog']");
          if (!dialog) return false;
          const t = (dialog.innerText || "").toLowerCase();
          if (t.includes("couldn't") || t.includes("something went wrong")) {
            return true;
          }
          if (t.includes("uploading") || t.includes("processing")) return false;
          const btn = dialog.querySelector(
            "[aria-label='Post'], [aria-label='Post'] div, div[aria-label='Post']"
          );
          if (!btn) return false;
          if (btn.getAttribute("aria-disabled") === "true") return false;
          if (!isVideo) return true;
          return Boolean(
            dialog.querySelector("video, img[src*='scontent'], img[src*='fbcdn']")
          );
        },
        { timeout: readyTimeout },
        videoPost
      ).catch(() => {});
      await delay(videoPost ? 4000 : 1500);
    }

    const posted = await clickFacebookPostButton(page);
    if (!posted) {
      throw new Error("Facebook Post button not found or still disabled");
    }
    console.log("Post clicked");

    await page.waitForFunction(() => !document.querySelector("[role='dialog']"), {
      timeout: 180000,
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
        const base = path.basename(file);
        if (base.startsWith("temp_") || base.startsWith("fb_")) {
          fs.unlinkSync(file);
        }
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
