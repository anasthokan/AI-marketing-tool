import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { saveImage } from "../utils/saveImage.js";
import { isVideoMedia, saveMediaFile, resolveUploadPath } from "../utils/media.js";
import { createMutex } from "../utils/mutex.js";
import {
  prepareBrowserProfile,
  useSinglePage,
  closeExtraPages,
  closeBrowserHard,
  resolveChromeLaunch,
} from "../utils/browserSession.js";

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

const VIEWPORT = { width: 1400, height: 1080, deviceScaleFactor: 1 };
const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--window-size=1400,1080",
  "--window-position=0,0",
  "--start-maximized",
  "--force-device-scale-factor=1",
  "--disable-restore-session-state",
  "--no-first-run",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
  "--disable-infobars",
  "--noerrdialogs",
];

const isDetachedErr = (err) =>
  /detached|Target closed|Session closed|Execution context was destroyed|Cannot find context/i.test(
    String(err?.message || err)
  );

const retryDetached = async (fn, tries = 6) => {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isDetachedErr(err) || i === tries - 1) throw err;
      console.log("Facebook retry after detached frame:", err.message);
      await delay(1200);
    }
  }
  throw last;
};

const dismissPopups = async (page) => {
  try {
    await page.evaluate(() => {
      const labels = [
        "not now",
        "close",
        "allow all cookies",
        "accept all",
        "decline optional cookies",
        "allow essential cookies",
      ];
      const nodes = Array.from(
        document.querySelectorAll("button, [role='button'], [aria-label]")
      );
      for (const el of nodes) {
        const t = (el.innerText || el.getAttribute("aria-label") || "")
          .trim()
          .toLowerCase()
          .split("\n")[0];
        if (!labels.includes(t) && t !== "close") continue;
        if (t === "close" && !el.closest("[role='dialog']")) continue;
        el.click();
      }
    });
  } catch {}
  try {
    await page.keyboard.press("Escape");
  } catch {}
  await delay(400);
};

const locateCreatePost = async (page) => {
  return retryDetached(() =>
    page.evaluate(() => {
      const sels = [
        "[aria-label='Create a post']",
        "[aria-label='Create Post']",
        "[aria-label='Create post']",
        "[aria-label='Create a new post']",
        "[aria-label='Create new post']",
        "[aria-placeholder*='on your mind']",
        "[aria-label*='on your mind']",
        "div[role='button'][aria-label*='Create a post']",
        "div[role='button'][aria-label*='Create Post']",
        "div[role='textbox'][aria-placeholder*='on your mind']",
      ];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const clickable = el.closest("[role='button'], button") || el;
        const r = clickable.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) {
          return {
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
            via: sel,
          };
        }
      }

      const nodes = Array.from(
        document.querySelectorAll("span, div[role='button'], [role='textbox']")
      );
      for (const n of nodes) {
        const t = (n.innerText || n.getAttribute("aria-label") || "")
          .trim()
          .toLowerCase();
        if (
          t.startsWith("what's on your mind") ||
          t.startsWith("whats on your mind") ||
          t.includes("on your mind") ||
          t.includes("what's on your mind")
        ) {
          const clickable = n.closest("[role='button'], button") || n;
          const r = clickable.getBoundingClientRect();
          if (r.width > 4 && r.height > 4) {
            return {
              x: r.left + Math.min(r.width, 240) / 2,
              y: r.top + r.height / 2,
              via: "mind",
            };
          }
        }
      }
      return null;
    })
  );
};

const findCreatePost = async (page, timeoutMs = 25000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await locateCreatePost(page).catch(() => null);
    if (found) return found;
    await delay(1000);
  }
  return null;
};

const applyStealth = async (page) => {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
};

const clickCreateFlyoutPost = async (page) => {
  const found = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll(
        "[role='menuitem'], [role='menu'] [role='button'], [role='dialog'] [role='button'], span, div"
      )
    );
    for (const n of nodes) {
      const t = (n.innerText || n.getAttribute("aria-label") || "")
        .trim()
        .toLowerCase()
        .split("\n")[0];
      if (t !== "post" && t !== "create post") continue;
      const clickable =
        n.closest("[role='menuitem'], [role='button'], button") || n;
      const r = clickable.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.height > 90) continue;
      return {
        x: r.left + Math.min(r.width, 200) / 2,
        y: r.top + r.height / 2,
      };
    }
    return null;
  }).catch(() => null);

  if (!found) return false;
  await humanClick(page, found.x, found.y, "Create menu Post");
  await delay(1200);
  return true;
};

const composerHasTextbox = async (page) =>
  page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll("[role='dialog']"));
    return dialogs.some((d) => {
      const box = d.querySelector("[role='textbox'], [contenteditable='true']");
      if (!box) return false;
      const r = box.getBoundingClientRect();
      return r.width > 20 && r.height > 10;
    });
  }).catch(() => false);

const waitForComposer = async (page) => {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await composerHasTextbox(page)) return true;
    await clickCreateFlyoutPost(page);
    await delay(600);
  }
  return false;
};

const isLoginPage = async (page) => {
  try {
    const loginForm = await page.$(
      "input#email, input[name='email'], input[name='pass']"
    );
    return Boolean(loginForm);
  } catch {
    return false;
  }
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
  return retryDetached(() => page.evaluate(() => {
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

    const dialogRect = dialog.getBoundingClientRect();
    const footerY = dialogRect.top + dialogRect.height * 0.4;
    hits.sort((a, b) => {
      const aFoot = a.y >= footerY ? 1 : 0;
      const bFoot = b.y >= footerY ? 1 : 0;
      return bFoot - aFoot || b.y - a.y || b.w - a.w;
    });
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
  }));
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
    prepareBrowserProfile(SESSION_DIR);

    const chrome = resolveChromeLaunch();
    console.log(
      `Facebook browser: ${chrome.label}${
        chrome.executablePath ? ` @ ${chrome.executablePath}` : ""
      }`
    );

    browser = await puppeteer.launch({
      headless: !isHeaded(),
      defaultViewport: VIEWPORT,
      args: CHROME_ARGS,
      userDataDir: SESSION_DIR,
      ...chrome.options,
    });

    const page = await useSinglePage(browser);
    await applyStealth(page);
    await page.setViewport(VIEWPORT);
    await maximizeWindow(page);

    await retryDetached(() =>
      page.goto("https://www.facebook.com/", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      })
    );
    await delay(4000);
    await closeExtraPages(browser, page);
    await dismissPopups(page);

    let createAt = await ensureLoggedIn(page);
    await dismissPopups(page);
    createAt = (await locateCreatePost(page).catch(() => null)) || createAt;
    if (!createAt) {
      const shot = path.resolve(`fb_debug_${Date.now()}.png`);
      try {
        await page.screenshot({ path: shot, fullPage: true });
        console.log("Debug screenshot:", shot);
      } catch {}
      throw new Error(
        "Could not find Facebook 'Create a post' after login wait."
      );
    }

    await humanClick(page, createAt.x, createAt.y, "Create post");
    await delay(1500);
    const composerOk = await waitForComposer(page);
    if (!composerOk) {
      const shot = path.resolve(`fb_debug_composer_${Date.now()}.png`);
      try {
        await page.screenshot({ path: shot, fullPage: true });
        console.log("Debug screenshot:", shot);
      } catch {}
      throw new Error(
        "Facebook composer did not open after Create. On RDP run: npm run fb:login"
      );
    }
    console.log("Post box opened");
    await delay(400);

    const videoPost =
      Array.isArray(imageInputs) && imageInputs.some(isVideoMedia);

    // Caption first — textbox is ready immediately; after video Facebook
    // often remounts the composer and typing there is slow/unreliable.
    await retryDetached(() => pasteCaption(page, caption));

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

      const collectFileInputs = async () => {
        const found = [];
        for (const frame of page.frames()) {
          try {
            found.push(...(await frame.$$("input[type='file']")));
          } catch {}
        }
        return found;
      };

      let fileInputs = await collectFileInputs();
      if (!fileInputs.length) {
        await clickPhotoVideo();
        await delay(700);
        fileInputs = await collectFileInputs();
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

      if (!(await retryDetached(() => captionLooksSet(page, caption)))) {
        console.log("Caption lost after media — re-entering");
        await retryDetached(() => pasteCaption(page, caption));
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

    try {
      await retryDetached(() =>
        page.waitForFunction(
          () => !document.querySelector("[role='dialog']"),
          { timeout: 180000 }
        )
      );
    } catch (err) {
      if (!isDetachedErr(err)) throw err;
      console.log("Facebook navigated after publish — treating as success");
    }

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
    await closeBrowserHard(browser, SESSION_DIR);
  }
};

export const postToFacebookBot = (caption, imageInputs) =>
  fbMutex.run(() => postOnce(caption, imageInputs));
