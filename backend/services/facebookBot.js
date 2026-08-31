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

const VIEWPORT = { width: 1400, height: 1080 };
const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--window-size=1400,1080",
  "--window-position=0,0",
  "--start-maximized",
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

const maximizeWindow = async (page) => {
  try {
    const session = await page.target().createCDPSession();
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "maximized" },
    });
  } catch (err) {
    console.log("Maximize skipped:", err.message);
  }
};

const captionLooksSet = async (page, caption) => {
  const start = String(caption || "").trim().slice(0, 40);
  return page.evaluate((prefix) => {
    const els = [
      ...document.querySelectorAll(
        "[role='dialog'] [role='textbox'], [role='dialog'] [contenteditable='true']"
      ),
    ];
    return els.some((el) => {
      const t = (el.innerText || "").trim();
      if (!t || /^what's on your mind/i.test(t)) return false;
      return !prefix || t.includes(prefix) || t.startsWith(prefix.slice(0, 20));
    });
  }, start);
};

const pasteCaption = async (page, caption) => {
  const box = await page.waitForSelector(
    "[role='dialog'] [role='textbox'], [role='dialog'] [contenteditable='true']",
    { timeout: 12000 }
  );
  await box.click({ delay: 40 });
  await delay(150);
  try {
    await page.keyboard.insertText(caption);
  } catch {
    await page.keyboard.type(caption, { delay: 0 });
  }

  if (!(await captionLooksSet(page, caption))) {
    console.log("insertText did not stick — retrying caption");
    await box.click({ delay: 40 });
    await delay(120);
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    try {
      await page.keyboard.insertText(caption);
    } catch {
      await page.keyboard.type(caption, { delay: 0 });
    }
  }

  // Close hashtag typeahead without closing the composer (Escape would close it).
  await page.evaluate(() => {
    const heading = document.querySelector(
      "[role='dialog'] h2, [role='dialog'] [role='heading']"
    );
    if (heading) heading.click();
  });
  console.log("Caption entered");
};

const shrinkComposerMedia = async (page) => {
  await page.evaluate(() => {
    const dialog = document.querySelector("[role='dialog']");
    if (!dialog) return 0;
    let n = 0;
    const boxes = [...dialog.querySelectorAll("div")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 240 && r.width > 180 && r.width < 720;
    });
    for (const el of boxes) {
      el.style.maxHeight = "220px";
      el.style.height = "220px";
      el.style.overflow = "hidden";
      n += 1;
    }
    for (const vid of dialog.querySelectorAll("video, img")) {
      vid.style.maxHeight = "220px";
      vid.style.objectFit = "contain";
    }
    return n;
  });
};

const humanClick = async (page, x, y, label) => {
  const px = Math.round(x);
  const py = Math.round(y);
  await page.mouse.move(px, py, { steps: 8 });
  await delay(80);
  await page.mouse.click(px, py, { delay: 60 });
  console.log(`Facebook ${label} clicked @ ${px},${py}`);
};

const inspectComposerAction = async (page) => {
  return page.evaluate(() => {
    const dialog = document.querySelector("[role='dialog']");
    if (!dialog) return { status: "no-dialog" };

    const text = (dialog.innerText || "").toLowerCase();
    if (
      text.includes("couldn't upload") ||
      text.includes("couldn’t upload") ||
      text.includes("something went wrong")
    ) {
      return { status: "upload-error" };
    }

    const busy =
      text.includes("uploading") ||
      text.includes("processing") ||
      text.includes("preparing") ||
      text.includes("almost ready");

    const isDisabled = (el) => {
      let n = el;
      for (let i = 0; i < 8 && n; i++) {
        if (
          n.getAttribute("aria-disabled") === "true" ||
          n.hasAttribute("disabled") ||
          n.getAttribute("aria-busy") === "true"
        ) {
          return true;
        }
        n = n.parentElement;
      }
      return false;
    };

    const firstLine = (el) =>
      (
        el.getAttribute("aria-label") ||
        el.innerText ||
        ""
      )
        .trim()
        .toLowerCase()
        .split("\n")[0]
        .trim();

    const classify = (label) => {
      if (!label) return null;
      if (
        label === "post" ||
        label === "post now" ||
        label === "share" ||
        label === "share now" ||
        label.startsWith("post as ") ||
        label === "पोस्ट" ||
        label === "पोस्ट करें"
      ) {
        return "post";
      }
      if (
        label === "next" ||
        label === "continue" ||
        label === "done" ||
        label === "अगला"
      ) {
        return "next";
      }
      return null;
    };

    const hits = [];
    const nodes = [
      ...dialog.querySelectorAll("[role='button'], button, [aria-label]"),
    ];
    for (const el of nodes) {
      const kind = classify(firstLine(el));
      if (!kind) continue;
      const clickable = el.closest("[role='button'], button") || el;
      const rect = clickable.getBoundingClientRect();
      const style = window.getComputedStyle(clickable);
      if (rect.width < 8 || rect.height < 8) continue;
      if (kind === "next" && (rect.width < 48 || rect.height < 24)) continue;
      if (style.visibility === "hidden" || style.display === "none") continue;
      if (Number(style.opacity) === 0) continue;
      hits.push({
        kind,
        disabled: isDisabled(clickable),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        w: rect.width,
        h: rect.height,
        label: firstLine(el),
      });
    }

    if (!hits.length) {
      return { status: busy ? "busy" : "missing", busy };
    }

    // Footer Post/Next is the bottom-most, then widest control.
    hits.sort((a, b) => b.y - a.y || b.w - a.w);
    const post = hits.find((h) => h.kind === "post");
    const next = hits.find((h) => h.kind === "next" && !h.disabled);
    // If Post is still greyed out (video processing / editor step), take Next.
    if (post && !post.disabled) {
      return { status: "ready", ...post, busy };
    }
    if (next) {
      return { status: "ready", ...next, busy };
    }
    if (post) {
      return { status: "disabled", ...post, busy };
    }
    return { status: busy ? "busy" : "missing", busy };
  });
};

const scrollComposerToPost = async (page) => {
  await shrinkComposerMedia(page);
  await page.evaluate(() => {
    const dialog = document.querySelector("[role='dialog']");
    if (!dialog) return;
    const all = [dialog, ...dialog.querySelectorAll("*")];
    for (const el of all) {
      const st = window.getComputedStyle(el);
      const oy = st.overflowY;
      if (
        (oy === "auto" || oy === "scroll" || oy === "overlay") &&
        el.scrollHeight > el.clientHeight + 20
      ) {
        el.scrollTop = el.scrollHeight;
      }
    }
    const labels = ["post", "share", "next", "continue", "done"];
    const btn = [...dialog.querySelectorAll("[role='button'], button, [aria-label]")]
      .filter((el) => {
        const t = (
          el.getAttribute("aria-label") ||
          el.innerText ||
          ""
        )
          .trim()
          .toLowerCase()
          .split("\n")[0];
        return labels.includes(t) || t.startsWith("post as ");
      })
      .pop();
    if (!btn) return;
    let p = btn.parentElement;
    while (p) {
      if (p.scrollHeight > p.clientHeight + 10) p.scrollTop = p.scrollHeight;
      p = p.parentElement;
    }
    btn.scrollIntoView({ block: "center", inline: "nearest" });
  });
};

const composerClosed = async (page) =>
  page.evaluate(() => !document.querySelector("[role='dialog']"));

/** Wait until Post/Share is enabled (video processing), clicking Next if needed. */
const waitForEnabledPostButton = async (page, videoPost) => {
  const timeout = videoPost ? 180000 : 45000;
  const deadline = Date.now() + timeout;
  let lastStatus = "";

  while (Date.now() < deadline) {
    await scrollComposerToPost(page);
    const info = await inspectComposerAction(page);
    const status = `${info.status}:${info.kind || ""}:${info.label || ""}`;
    if (status !== lastStatus) {
      console.log("Facebook composer action:", info);
      lastStatus = status;
    }

    if (info.status === "no-dialog") return { ok: false, reason: "no-dialog" };
    if (info.status === "upload-error") {
      return { ok: false, reason: "upload-error" };
    }

    if (info.kind === "next" && info.status === "ready") {
      await humanClick(page, info.x, info.y, "Next");
      await delay(1200);
      continue;
    }

    if (info.kind === "post" && info.status === "ready") {
      return { ok: true, info };
    }

    await delay(1200);
  }

  return { ok: false, reason: "timeout" };
};

/** Real mouse click — Facebook ignores synthetic dispatchEvent clicks. */
const clickFacebookPostButton = async (page) => {
  for (let i = 0; i < 8; i++) {
    if (await composerClosed(page)) return true;
    await scrollComposerToPost(page);
    const info = await inspectComposerAction(page);
    console.log("Facebook Post button:", info);
    if (info.status === "no-dialog") return true;
    if (info.kind === "next" && info.status === "ready") {
      await humanClick(page, info.x, info.y, "Next");
      await delay(1200);
      continue;
    }
    if (info.kind === "post" && info.status === "ready") {
      await humanClick(page, info.x, info.y, "Post");
      await delay(1500);
      if (await composerClosed(page)) return true;
      continue;
    }
    await delay(800);
  }

  return composerClosed(page);
};

const submitFacebookPost = async (page, videoPost = false) => {
  const waited = await waitForEnabledPostButton(page, videoPost);
  if (!waited.ok) {
    if (waited.reason === "no-dialog") return true;
    console.log("Facebook Post wait failed:", waited.reason);
    return false;
  }

  await page.keyboard.down("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");
  console.log("Sent Ctrl+Enter (Facebook publish shortcut)");
  await delay(800);

  if (await composerClosed(page)) return true;
  return clickFacebookPostButton(page);
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
    await maximizeWindow(page);
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    await page.goto("https://www.facebook.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await delay(800);
    try {
      await page.keyboard.press("Escape");
    } catch {}
    await delay(400);

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
    await page.waitForSelector("[role='dialog']", { timeout: 20000 });
    await delay(400);

    const videoPost =
      Array.isArray(imageInputs) && imageInputs.some(isVideoMedia);

    // Caption first — textbox is ready immediately; after video Facebook
    // often remounts the composer and typing there is slow/unreliable.
    await pasteCaption(page, caption);

    if (imageInputs && imageInputs.length > 0) {

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

      const clickPhotoVideo = async () => {
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
      };

      let fileInputs = await page.$$("[role='dialog'] input[type='file']");
      if (!fileInputs.length) {
        await clickPhotoVideo();
        await delay(700);
        fileInputs = await page.$$("[role='dialog'] input[type='file']");
      }

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
      await shrinkComposerMedia(page);

      if (!(await captionLooksSet(page, caption))) {
        console.log("Caption lost after media — re-entering");
        await pasteCaption(page, caption);
      }
    }

    const posted = await submitFacebookPost(page, videoPost);
    if (!posted) {
      try {
        const shot = path.resolve(`fb_debug_postbtn_${Date.now()}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        console.log("Debug screenshot:", shot);
      } catch {}
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
    if (isHeaded() && browser) {
      console.log(
        "Chrome staying open 2 minutes — press Ctrl+Enter to publish, or scroll the composer and click Post."
      );
      await delay(120000);
    }
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
