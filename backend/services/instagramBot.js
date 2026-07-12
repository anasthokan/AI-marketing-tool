import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { saveImage } from "../utils/saveImage.js";
import { createMutex } from "../utils/mutex.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.resolve(__dirname, "..", "instagram-session");
const igMutex = createMutex();
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const isHeaded = () => {
  const v = String(process.env.PUPPETEER_HEADLESS ?? "true")
    .trim()
    .toLowerCase();
  return v === "false" || v === "0" || v === "no";
};

const safeHas = async (page, selector) => {
  try {
    if (page.isClosed()) return false;
    return Boolean(await page.$(selector));
  } catch {
    return false;
  }
};

const isLoginPage = async (page) => {
  const url = page.url();
  if (
    url.includes("/accounts/login") ||
    url.includes("/accounts/emailsignup") ||
    url.includes("/challenge")
  ) {
    return true;
  }

  const loginUser = await safeHas(
    page,
    'input[name="username"], input[aria-label="Phone number, username, or email"]'
  );
  const loginPass = await safeHas(
    page,
    'input[name="password"], input[aria-label="Password"]'
  );
  return Boolean(loginUser && loginPass);
};

const isLoggedIn = async (page) => {
  if (await isLoginPage(page)) return false;

  const markers = [
    "svg[aria-label='New post']",
    "svg[aria-label='New Post']",
    "svg[aria-label='Home']",
    "svg[aria-label='Search']",
    "svg[aria-label='Reels']",
    "svg[aria-label='Messenger']",
    "a[href='/direct/inbox/']",
  ];
  for (const sel of markers) {
    if (await safeHas(page, sel)) return true;
  }
  return false;
};

/**
 * If not logged in and headed mode: keep Chrome open so user can login on RDP.
 */
const ensureLoggedIn = async (page) => {
  if (await isLoggedIn(page)) return true;

  const onLogin = await isLoginPage(page);
  if (!onLogin) {
    await delay(5000);
    if (await isLoggedIn(page)) return true;
  }

  if (!isHeaded()) {
    throw new Error(
      "Instagram not logged in. On the server RDP: set PUPPETEER_HEADLESS=false, restart PM2, schedule a post, login in the open Chrome window — or run: npm run ig:login"
    );
  }

  const waitMs = Number(process.env.IG_LOGIN_WAIT_MS || 600000); // 10 min
  console.log(
    `Instagram login required. Chrome will stay open for ${Math.round(
      waitMs / 1000
    )}s — login on RDP now...`
  );

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) {
      console.log("Instagram login detected — continuing post.");
      return true;
    }
    await delay(3000);
  }

  throw new Error(
    "Timed out waiting for Instagram login on server. Run: npm run ig:login"
  );
};

const saveDebugShot = async (page, label) => {
  try {
    const shot = path.resolve(`ig_debug_${label}_${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.log("Debug screenshot:", shot);
  } catch {}
};

// ================= ENABLE CAROUSEL =================
const enableCarousel = async (page) => {
  try {
    await page.waitForSelector("button", { timeout: 5000 });

    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const target = btns.find((b) =>
        b.innerText?.toLowerCase().includes("select multiple")
      );
      if (target) {
        target.click();
        return true;
      }
      return false;
    });

    if (clicked) {
      console.log("✅ Carousel enabled");
    } else {
      console.log("❌ Carousel button NOT found");
    }
  } catch (err) {
    console.log("❌ Carousel error:", err.message);
  }
};

// ================= CLICK CREATE =================
const clickCreate = async (page) => {
  const selectors = [
    "svg[aria-label='New post']",
    "svg[aria-label='New Post']",
    "svg[aria-label='Create']",
  ];

  for (let i = 0; i < 8; i++) {
    for (const sel of selectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          console.log("✅ Create clicked");
          return;
        }
      } catch {}
    }

    // Fallback: sidebar Create / New post text
    const clicked = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("a, div, span"));
      const el = nodes.find((n) => {
        const t = (n.innerText || "").trim().toLowerCase();
        return t === "create" || t === "new post";
      });
      if (!el) return false;
      el.click();
      return true;
    });
    if (clicked) {
      console.log("✅ Create clicked (fallback)");
      return;
    }

    await delay(2000);
  }

  await saveDebugShot(page, "no_create");
  throw new Error("❌ Create button not found (are you logged in?)");
};

const CAPTION_SELECTORS = [
  'div[aria-label="Write a caption..."]',
  'div[aria-label*="Write a caption"]',
  'textarea[aria-label="Write a caption..."]',
  'textarea[aria-label*="caption"]',
  'div[aria-label*="caption" i]',
  '[contenteditable="true"][role="textbox"]',
  'div[role="textbox"][contenteditable="true"]',
  "textarea",
  'div[role="textbox"]',
  '[contenteditable="true"]',
];

const findCaptionBox = async (page) => {
  for (const sel of CAPTION_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const visible = await page.evaluate((node) => {
        const r = node.getBoundingClientRect();
        return r.width > 10 && r.height > 10;
      }, el);
      if (visible) return el;
    } catch {}
  }
  return null;
};

const hasCaptionBox = async (page) => Boolean(await findCaptionBox(page));

const hasShareButton = async (page) => {
  return page.evaluate(() => {
    const dialog = document.querySelector("div[role='dialog']") || document.body;
    const nodes = Array.from(
      dialog.querySelectorAll("button, [role='button'], div, span")
    );
    return nodes.some((n) => {
      const t = (n.innerText || "").trim().toLowerCase();
      return t === "share" || t === "post";
    });
  });
};

const onCaptionScreen = async (page) =>
  (await hasCaptionBox(page)) || (await hasShareButton(page));

const logDialogStep = async (page) => {
  try {
    const info = await page.evaluate(() => {
      const dialog = document.querySelector("div[role='dialog']");
      if (!dialog) return "no-dialog";
      const h = dialog.querySelector("h1, h2, [role='heading']");
      return (h?.innerText || dialog.innerText || "").slice(0, 80).replace(/\s+/g, " ");
    });
    console.log("🧭 Dialog:", info);
  } catch {}
};

/**
 * Click dialog control by label using real mouse coords (Instagram ignores DOM .click()).
 * Prefers the rightmost match in the dialog header area.
 */
const clickByExactText = async (
  page,
  labels,
  labelName,
  { required = true } = {}
) => {
  const wanted = labels.map((l) => l.toLowerCase());

  for (let i = 0; i < 12; i++) {
    try {
      const found = await page.evaluate((wantedLabels) => {
        const dialog =
          document.querySelector("div[role='dialog']") || document.body;

        const matches = [];
        const candidates = Array.from(
          dialog.querySelectorAll("button, [role='button'], a, div, span")
        );

        for (const el of candidates) {
          const t = (el.innerText || "").trim().toLowerCase();
          if (!wantedLabels.includes(t)) continue;

          const clickable = el.closest("button, [role='button'], a") || el;
          const rect = clickable.getBoundingClientRect();
          const style = window.getComputedStyle(clickable);
          if (rect.width < 2 || rect.height < 2) continue;
          if (style.visibility === "hidden" || style.display === "none") continue;
          if (Number(style.opacity) === 0) continue;

          matches.push({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            right: rect.right,
            top: rect.top,
          });
        }

        if (!matches.length) return null;

        // Header Next/Share is usually top-right of the dialog
        matches.sort((a, b) => b.right - a.right || a.top - b.top);
        return matches[0];
      }, wanted);

      if (found) {
        await page.mouse.click(found.x, found.y, { delay: 50 });
        console.log(`✅ ${labelName} clicked`);
        return true;
      }
    } catch {}

    await delay(1500);
  }

  if (!required) {
    console.log(`⏭️ ${labelName} skipped (not on this step)`);
    return false;
  }

  await saveDebugShot(page, `no_${labelName.toLowerCase()}`);
  throw new Error(`❌ ${labelName} button not found`);
};

const clickNext = (page, opts) =>
  clickByExactText(page, ["next", "ok", "continue"], "Next", opts);

const clickShare = (page) =>
  clickByExactText(page, ["share", "post"], "Share");

/**
 * Instagram crop → filters → caption. Advance until caption/share UI appears.
 */
const advanceToCaption = async (page) => {
  await logDialogStep(page);

  for (let step = 1; step <= 4; step++) {
    if (await onCaptionScreen(page)) {
      console.log(`✅ Caption screen ready (before Next #${step})`);
      return;
    }

    const required = step <= 2;
    const clicked = await clickNext(page, { required });
    await delay(6000);
    await logDialogStep(page);

    if (await onCaptionScreen(page)) {
      console.log(`✅ Caption screen ready (after Next #${step})`);
      return;
    }

    if (!clicked && step > 2) break;
  }

  if (await onCaptionScreen(page)) return;

  await saveDebugShot(page, "no_caption");
  throw new Error("❌ Caption screen not reached after Next steps");
};

/** Confirm Instagram actually finished publishing (not just Share click). */
const waitForPostShared = async (page) => {
  const phrases = [
    "your post has been shared",
    "post shared",
    "reel shared",
    "your reel has been shared",
  ];

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const ok = await page.evaluate((list) => {
      const text = (document.body?.innerText || "").toLowerCase();
      return list.some((p) => text.includes(p));
    }, phrases);

    if (ok) {
      console.log("🚀 POST CONFIRMED — Instagram shared successfully");
      return true;
    }
    await delay(2000);
  }

  await saveDebugShot(page, "no_share_confirm");
  return false;
};

// ================= MAIN BOT =================
export const postToInstagramBot = (caption, imageInputs) =>
  igMutex.run(() => postOnce(caption, imageInputs));

const postOnce = async (caption, imageInputs) => {
  let browser = null;
  const imagePaths = [];

  try {
    if (!imageInputs || imageInputs.length === 0) {
      throw new Error("No images provided for Instagram");
    }

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

    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await delay(5000);

    await ensureLoggedIn(page);

    const images = Array.isArray(imageInputs)
      ? imageInputs.slice(0, 10)
      : [imageInputs];

    for (let i = 0; i < images.length; i++) {
      const uniqueName = `${Date.now()}_${i}_${Math.random()
        .toString(36)
        .substring(7)}`;
      const imgPath = path.resolve(`temp_${uniqueName}.png`);

      const saved = await saveImage(images[i], imgPath);
      if (saved) imagePaths.push(imgPath);
    }

    console.log("📦 Files ready:", imagePaths);

    if (imagePaths.length === 0) {
      throw new Error("Failed to prepare any Instagram images");
    }

    await clickCreate(page);
    await delay(5000);

    if (imagePaths.length > 1) {
      console.log("🟢 Enabling carousel mode...");
      await page.keyboard.down("Shift");
      await enableCarousel(page);
      await delay(4000);
    }

    await page.waitForSelector("input[type='file']", { timeout: 20000 });
    const fileInput = await page.$("input[type='file']");
    await fileInput.uploadFile(...imagePaths);
    await page.keyboard.up("Shift");
    console.log("✅ Images uploaded");

    await delay(5000);

    // Wait until crop/Next UI is ready after upload
    await page.waitForFunction(
      () => {
        const dialog = document.querySelector("div[role='dialog']");
        if (!dialog) return false;
        const text = (dialog.innerText || "").toLowerCase();
        return text.includes("next") || text.includes("crop");
      },
      { timeout: 30000 }
    ).catch(() => {});

    await advanceToCaption(page);

    const box = await findCaptionBox(page);
    if (!box) {
      await saveDebugShot(page, "caption_missing");
      throw new Error("Caption box not found on caption screen");
    }

    await box.click({ clickCount: 1 });
    await delay(500);
    await page.keyboard.type(caption, { delay: 20 });
    console.log("✅ Caption added");

    await delay(3000);
    await clickShare(page);

    const confirmed = await waitForPostShared(page);
    if (!confirmed) {
      throw new Error(
        "Share was clicked but Instagram did not confirm the post. Session may be expired — run npm run ig:login on the server."
      );
    }

    await delay(3000);
    return { success: true };
  } catch (err) {
    console.log("❌ FINAL ERROR:", err.message);
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
