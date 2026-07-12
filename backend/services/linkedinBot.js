import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { saveImage } from "../utils/saveImage.js";
import { createMutex } from "../utils/mutex.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.resolve(__dirname, "..", "linkedin-session");
const liMutex = createMutex();
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const isHeaded = () => {
  const v = String(process.env.PUPPETEER_HEADLESS ?? "true")
    .trim()
    .toLowerCase();
  return v === "false" || v === "0" || v === "no";
};

const START_POST_SELECTORS = [
  "button.share-box-feed-entry__trigger",
  "[aria-label='Start a post']",
  "button[aria-label*='Start a post']",
  ".share-box-feed-entry__trigger",
];

const findStartPost = async (page, timeoutMs = 25000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of START_POST_SELECTORS) {
      const el = await page.$(sel);
      if (el) return el;
    }

    const byText = await page.evaluateHandle(() => {
      const nodes = Array.from(
        document.querySelectorAll("button, span, div[role='button']")
      );
      return (
        nodes.find((n) => {
          const t = (n.innerText || n.textContent || "").trim().toLowerCase();
          return t === "start a post" || t.startsWith("start a post");
        }) || null
      );
    });
    if (byText && byText.asElement()) return byText.asElement();

    await delay(1000);
  }
  return null;
};

const isLoginPage = async (page) => {
  const url = page.url();
  if (url.includes("/login") || url.includes("/uas/login") || url.includes("/checkpoint")) {
    return true;
  }
  const loginForm = await page.$(
    "input#username, input[name='session_key'], input#password, input[name='session_password']"
  );
  return Boolean(loginForm);
};

/**
 * If not logged in and headed mode: keep Chrome open so user can login on RDP.
 */
const ensureLoggedIn = async (page) => {
  const headed = isHeaded();
  const startBtn = await findStartPost(page, 5000);
  if (startBtn) return startBtn;

  const onLogin = await isLoginPage(page);
  if (!onLogin) {
    return findStartPost(page, 20000);
  }

  if (!headed) {
    throw new Error(
      "LinkedIn not logged in. Set PUPPETEER_HEADLESS=false, restart PM2, schedule a post, login in the open Chrome window (it will wait), then set headless true again. Or run: npm run li:login"
    );
  }

  const waitMs = Number(process.env.LI_LOGIN_WAIT_MS || 600000); // 10 min
  console.log(
    `LinkedIn login required. Chrome will stay open for ${Math.round(
      waitMs / 1000
    )}s — login on RDP now...`
  );

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const btn = await findStartPost(page, 3000);
    if (btn) {
      console.log("LinkedIn login detected — continuing post.");
      return btn;
    }
    const stillLogin = await isLoginPage(page);
    if (!stillLogin) {
      const btn2 = await findStartPost(page, 10000);
      if (btn2) return btn2;
    }
    await delay(2000);
  }

  throw new Error("Timed out waiting for LinkedIn login on server.");
};

const clickPostButton = async (page) => {
  const selectors = [
    "button.share-actions__primary-action",
    "[role='dialog'] button.share-actions__primary-action",
    "button[aria-label='Post']",
    "[role='dialog'] button[aria-label='Post']",
  ];

  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) {
      const disabled = await page.evaluate(
        (el) => el.disabled || el.getAttribute("aria-disabled") === "true",
        btn
      );
      if (!disabled) {
        await btn.click({ delay: 100 });
        return true;
      }
    }
  }

  const clicked = await page.evaluate(() => {
    const dialog = document.querySelector("[role='dialog']") || document.body;
    const buttons = Array.from(dialog.querySelectorAll("button"));
    const postBtn = buttons.find((b) => {
      const t = (b.innerText || b.textContent || "").trim().toLowerCase();
      return t === "post" || t === "post now";
    });
    if (!postBtn || postBtn.disabled) return false;
    postBtn.click();
    return true;
  });

  return clicked;
};

const postOnce = async (caption, imageInputs) => {
  let browser = null;
  const imagePaths = [];

  try {
    const lockFile = path.join(SESSION_DIR, "SingletonLock");
    if (fs.existsSync(lockFile)) {
      try {
        fs.unlinkSync(lockFile);
      } catch {}
    }

    browser = await puppeteer.launch({
      headless: !isHeaded(),
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

    await page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await delay(5000);

    let startBtn = await ensureLoggedIn(page);
    if (!startBtn) {
      const shot = path.resolve(`li_debug_${Date.now()}.png`);
      try {
        await page.screenshot({ path: shot, fullPage: true });
        console.log("Debug screenshot:", shot);
      } catch {}
      throw new Error("Could not find LinkedIn 'Start a post' after login wait.");
    }

    await startBtn.click();
    console.log("LinkedIn post box opened");
    await delay(4000);

    const textbox = await page.waitForSelector(
      "[role='dialog'] div.ql-editor[contenteditable='true'], [role='dialog'] div[role='textbox'], div.ql-editor[contenteditable='true'], div[role='textbox']",
      { visible: true, timeout: 20000 }
    );
    await textbox.click();
    await page.keyboard.type(caption, { delay: 15 });
    console.log("Caption added");
    await delay(2000);

    if (imageInputs && imageInputs.length > 0) {
      for (let i = 0; i < imageInputs.length; i++) {
        const imgPath = path.resolve(`li_${Date.now()}_${i}.png`);
        const saved = await saveImage(imageInputs[i], imgPath);
        if (saved) imagePaths.push(imgPath);
      }

      if (imagePaths.length === 0) {
        throw new Error("Failed to prepare any LinkedIn images");
      }

      // Open media picker if needed, then upload via file input
      const mediaClicked = await page.evaluate(() => {
        const dialog = document.querySelector("[role='dialog']") || document.body;
        const candidates = Array.from(
          dialog.querySelectorAll("button, [role='button']")
        );
        const media = candidates.find((el) => {
          const label = (
            el.getAttribute("aria-label") ||
            el.innerText ||
            ""
          ).toLowerCase();
          return (
            label.includes("add a photo") ||
            label.includes("add media") ||
            label.includes("photo") ||
            label.includes("image")
          );
        });
        if (media) {
          media.click();
          return true;
        }
        return false;
      });
      if (mediaClicked) await delay(2000);

      let fileInput = await page.$(
        "[role='dialog'] input[type='file'], input[type='file'][accept*='image'], input[type='file']"
      );
      if (!fileInput) {
        await page.evaluate(() => {
          const dialog = document.querySelector("[role='dialog']") || document.body;
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
        fileInput = await page.$(
          "[role='dialog'] input[type='file'], input[type='file']"
        );
      }

      if (!fileInput) throw new Error("LinkedIn file input not found");
      await fileInput.uploadFile(...imagePaths);
      console.log("Images uploaded");
      await delay(5000);

      // If media modal has a Done/Next, click it
      await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll("[role='dialog']"));
        for (const dialog of dialogs) {
          const buttons = Array.from(dialog.querySelectorAll("button"));
          const done = buttons.find((b) => {
            const t = (b.innerText || "").trim().toLowerCase();
            return t === "done" || t === "next" || t === "add";
          });
          if (done && !done.disabled) {
            done.click();
            return;
          }
        }
      });
      await delay(2000);
    }

    const posted = await clickPostButton(page);
    if (!posted) throw new Error("LinkedIn Post button not found or disabled");
    console.log("Post clicked");

    try {
      await page.waitForFunction(
        () => {
          const dialogs = document.querySelectorAll("[role='dialog']");
          // Composer usually closes after post; allow other toasts
          return dialogs.length === 0;
        },
        { timeout: 90000 }
      );
    } catch {
      // Dialog may linger with success toast — still treat as ok if we clicked Post
      console.log("LinkedIn dialog did not close in time; continuing.");
    }

    console.log("LinkedIn post done");
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
    await delay(3000);
  }
};

export const postToLinkedInBot = (caption, imageInputs) =>
  liMutex.run(() => postOnce(caption, imageInputs));
