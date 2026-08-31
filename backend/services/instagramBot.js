import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { saveImage } from "../utils/saveImage.js";
import { isVideoMedia, saveMediaFile, resolveUploadPath } from "../utils/media.js";
import { createMutex } from "../utils/mutex.js";
import { resolveIgBrowserLaunch, assertEdgeProcess } from "../utils/igBrowser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Edge profile (separate from Chrome) — Instagram blocks Chromium more often on servers
const SESSION_DIR = path.resolve(__dirname, "..", "instagram-session-edge");
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
 * If not logged in and headed mode: keep Edge open so user can login on RDP.
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
      "Instagram not logged in. On the server RDP: set PUPPETEER_HEADLESS=false, restart PM2, schedule a post, login in the open Edge window — or run: npm run ig:login"
    );
  }

  const waitMs = Number(process.env.IG_LOGIN_WAIT_MS || 600000); // 10 min
  console.log(
    `Instagram login required. Edge will stay open for ${Math.round(
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

/** RDP/DPI-safe click: move first, then press. Instagram ignores DOM .click(). */
const humanClick = async (page, x, y, label) => {
  const px = Math.round(x);
  const py = Math.round(y);
  await page.mouse.move(px, py, { steps: 12 });
  await delay(160);
  await page.mouse.click(px, py, { delay: 70 });
  console.log(`✅ ${label} clicked @ ${px},${py}`);
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

const clickLeftNav = async (page, labels, labelName) => {
  const wanted = labels.map((l) => l.toLowerCase());
  for (let i = 0; i < 10; i++) {
    const found = await page.evaluate((wantedLabels) => {
      const nodes = Array.from(
        document.querySelectorAll(
          "a, span, div, button, svg, [role='link'], [role='button'], [role='menuitem']"
        )
      );
      for (const n of nodes) {
        const raw = (n.innerText || "").trim().toLowerCase();
        const first = raw.split("\n")[0].trim();
        const al = (n.getAttribute("aria-label") || "").toLowerCase();
        const hit = wantedLabels.some((w) => {
          if (w === "+") {
            return first === "+" || al === "+" || al === "plus";
          }
          return (
            first === w ||
            raw === w ||
            raw === `+ ${w}` ||
            al === w
          );
        });
        if (!hit) continue;
        const clickable =
          n.closest(
            "a, [role='link'], [role='button'], [role='menuitem'], button"
          ) || n;
        const rect = clickable.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        if (rect.left > 420) continue;
        const navHref = (
          clickable.closest("a")?.getAttribute("href") || ""
        ).toLowerCase();
        if (/\/reels\/?(\?|$)/.test(navHref) || navHref.includes("/direct/")) {
          continue;
        }
        const style = window.getComputedStyle(clickable);
        if (style.visibility === "hidden" || style.display === "none") continue;
        if (Number(style.opacity) === 0) continue;
        return {
          x: rect.left + Math.min(rect.width, 48) / 2,
          y: rect.top + rect.height / 2,
          label: first || al || wantedLabels[0],
        };
      }
      return null;
    }, wanted);

    if (found) {
      await humanClick(page, found.x, found.y, labelName);
      await delay(2000);
      return found;
    }
    await delay(400);
  }
  return null;
};

const clickPlusIcon = async (page) => {
  for (let i = 0; i < 10; i++) {
    const target = await page.evaluate(() => {
      const sels = [
        "svg[aria-label='New post']",
        "svg[aria-label='New Post']",
        "svg[aria-label='Plus']",
        "svg[aria-label='+']",
        "[aria-label='New post']",
        "[aria-label='Plus']",
      ];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const clickable =
          el.closest("a, div[role='link'], div[role='button'], button") || el;
        const rect = clickable.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        if (rect.left > 420) continue;
        const navHref = (
          clickable.closest("a")?.getAttribute("href") || ""
        ).toLowerCase();
        if (/\/reels\/?(\?|$)/.test(navHref)) continue;
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }

      const nodes = Array.from(
        document.querySelectorAll(
          "a, span, div, button, [role='link'], [role='button']"
        )
      );
      for (const n of nodes) {
        const raw = (n.innerText || "").trim();
        const first = raw.split("\n")[0].trim();
        if (first !== "+") continue;
        const clickable =
          n.closest("a, [role='link'], [role='button'], button") || n;
        const rect = clickable.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        if (rect.left > 420) continue;
        const navHref = (
          clickable.closest("a")?.getAttribute("href") || ""
        ).toLowerCase();
        if (/\/reels\/?(\?|$)/.test(navHref)) continue;
        return {
          x: rect.left + Math.min(rect.width, 40) / 2,
          y: rect.top + rect.height / 2,
        };
      }
      return null;
    });

    if (target) {
      await humanClick(page, target.x, target.y, "Plus (+)");
      await delay(2000);
      return target;
    }
    await delay(500);
  }

  await saveDebugShot(page, "no_plus");
  throw new Error("❌ Plus (+) icon not found in Instagram sidebar");
};

const clickCreateMenu = async (page) => {
  const found = await clickLeftNav(page, ["create"], "Create");
  if (!found) {
    await saveDebugShot(page, "no_create_menu");
    throw new Error("❌ Create not found after clicking +");
  }
  return found;
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
    const dialog = document.querySelector("div[role='dialog']");
    if (!dialog) return false;
    const nodes = Array.from(
      dialog.querySelectorAll("button, [role='button'], div, span")
    );
    return nodes.some((n) => {
      const t = (n.innerText || "").trim().toLowerCase();
      return t === "share" || t === "share now";
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
          const raw = (el.innerText || "").trim().toLowerCase();
          const first = raw.split("\n")[0].trim();
          if (!wantedLabels.includes(raw) && !wantedLabels.includes(first)) {
            continue;
          }

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
  clickByExactText(page, ["next", "ok", "continue", "done"], "Next", opts);

const clickShare = (page) =>
  clickByExactText(page, ["share", "post", "share now"], "Share");

/**
 * Click "Post" in the Create flyout (the submenu just below/beside Create).
 * Previous matcher failed on RDP because:
 *  - parent container innerText starts with "Post" so it clicked the whole menu
 *  - flyout sits to the right of the nav (left > 420 was skipped)
 *  - RDP DPI made instant mouse.click miss the small row
 */
const pickComposerMode = async (page, _videoPost, createAnchor) => {
  for (let attempt = 0; attempt < 16; attempt++) {
    const result = await page.evaluate((anchor) => {
      const isFeedNav = (el) => {
        const a = el.closest("a");
        const href = (a?.getAttribute("href") || "").toLowerCase();
        if (href.includes("/create")) return false;
        return (
          /\/reels\/?(\?|$)/.test(href) ||
          href.includes("/direct/") ||
          href.includes("/explore") ||
          href === "/" ||
          href.startsWith("/?")
        );
      };

      const isPostLabel = (first, raw, al) => {
        const blocked = new Set([
          "create",
          "new post",
          "reels",
          "reel",
          "story",
          "live",
          "live video",
          "ad",
        ]);
        if (blocked.has(first) || blocked.has(al)) return false;
        const ok = (t) => {
          if (!t) return false;
          if (t === "post") return true;
          if (t.startsWith("post ") && !t.includes("shared") && !t.includes("posted")) {
            return true;
          }
          return false;
        };
        return ok(first) || ok(raw) || ok(al);
      };

      const nodes = Array.from(
        document.querySelectorAll(
          "[role='menuitem'], [role='menu'] *, [role='listbox'] *, [role='dialog'] *, svg[aria-label], [aria-label], button, a, span, div"
        )
      );

      const candidates = [];
      for (const n of nodes) {
        const raw = (n.innerText || "").trim().toLowerCase();
        const lines = raw
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        const first = (lines[0] || "").trim();
        const al = (
          n.getAttribute("aria-label") ||
          ""
        ).toLowerCase();

        // Whole flyout container: "Post / Live / Ad" — skip, click the row not the box
        if (lines.length >= 3) continue;
        if (isFeedNav(n)) continue;
        if (!isPostLabel(first, raw, al)) continue;

        const clickable =
          n.closest("[role='menuitem'], [role='button'], a, button") || n;
        if (isFeedNav(clickable)) continue;

        const rect = clickable.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;
        if (rect.height > 96) continue;
        if (rect.width > 480) continue;
        // Flyout is beside the left nav — allow well past 420 for RDP wide layout
        if (rect.left > 760) continue;

        const style = window.getComputedStyle(clickable);
        if (style.visibility === "hidden" || style.display === "none") continue;
        if (Number(style.opacity) === 0) continue;

        const x = rect.left + Math.min(rect.width, 180) / 2;
        const y = rect.top + rect.height / 2;

        if (anchor) {
          const dist = Math.hypot(x - anchor.x, y - anchor.y);
          if (dist < 28) continue;
        }

        let score = 0;
        const role = (clickable.getAttribute("role") || "").toLowerCase();
        if (role === "menuitem") score += 24;
        if (n.closest("[role='menu'], [role='dialog'], [role='listbox']")) score += 16;
        if (rect.height <= 64) score += 8;
        if (first === "post" || al === "post") score += 10;
        if (anchor) {
          if (y > anchor.y - 10 && y < anchor.y + 300) score += 14;
          if (x >= anchor.x - 40 && x <= anchor.x + 460) score += 12;
          score -= Math.abs(y - (anchor.y + 50)) / 8;
        }
        score -= (rect.width * rect.height) / 10000;

        candidates.push({
          x,
          y,
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          label: first || al || "post",
          score,
        });
      }

      candidates.sort((a, b) => b.score - a.score);
      return {
        hit: candidates[0] || null,
        debug: candidates.slice(0, 8),
      };
    }, createAnchor || null);

    if (attempt === 0 || attempt === 4) {
      console.log(
        "Create→Post candidates:",
        result?.debug?.length
          ? result.debug
              .map(
                (c) =>
                  `${c.label} @${Math.round(c.x)},${Math.round(c.y)} ${c.w}x${c.h} s=${c.score?.toFixed?.(1) ?? c.score}`
              )
              .join(" | ")
          : "(none yet)"
      );
    }

    if (result?.hit) {
      await humanClick(page, result.hit.x, result.hit.y, "Composer Post");
      await delay(2500);
      return result.hit.label || "post";
    }
    await delay(450);
  }

  const flyoutOpen = await page.evaluate((anchor) => {
    if (document.querySelector("[role='menu'], [role='menuitem']")) return true;
    const smallDialog = Array.from(document.querySelectorAll("[role='dialog']")).some(
      (d) => {
        const r = d.getBoundingClientRect();
        return (
          r.width > 80 &&
          r.width < 480 &&
          r.height > 60 &&
          r.height < 520 &&
          r.left < 760
        );
      }
    );
    if (smallDialog) return true;
    if (!anchor) return false;
    return Array.from(document.querySelectorAll("span, div, [role='button']")).some(
      (n) => {
        const t = (n.innerText || "").trim().toLowerCase().split("\n")[0];
        if (t !== "post") return false;
        const r = n.getBoundingClientRect();
        if (r.height < 8 || r.height > 90 || r.left > 760) return false;
        return Math.abs(r.top - (anchor.y || 0)) < 280;
      }
    );
  }, createAnchor || null);

  if (createAnchor && flyoutOpen) {
    const offsets = [
      { x: 90, y: 48 },
      { x: 120, y: 56 },
      { x: 40, y: 52 },
      { x: 8, y: 48 },
    ];
    for (const off of offsets) {
      const x = createAnchor.x + off.x;
      const y = createAnchor.y + off.y;
      console.log(`Trying Post row offset below Create (${off.x},${off.y})`);
      await humanClick(page, x, y, "Composer Post (below Create)");
      await delay(1800);
      const opened = await safeHas(page, "input[type='file']");
      if (opened) return "post";
    }
  }

  await saveDebugShot(page, "no_create_post");
  console.log("⏭️ Composer menu not shown — trying upload on current screen");
  return null;
};

const waitForUploadUi = async (page, videoPost) => {
  const timeout = videoPost ? 180000 : 40000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const dialog = document.querySelector("div[role='dialog']") || document.body;
      const t = (dialog.innerText || "").toLowerCase();
      if (
        t.includes("couldn't upload") ||
        t.includes("couldn’t upload") ||
        t.includes("something went wrong") ||
        t.includes("failed to upload") ||
        t.includes("video is too")
      ) {
        return "error";
      }
      const labels = Array.from(
        dialog.querySelectorAll("button, [role='button'], div, span")
      ).map((n) => (n.innerText || "").trim().toLowerCase());
      const hasAction = labels.some((x) =>
        ["next", "ok", "continue", "done", "share", "post"].includes(x)
      );
      if (
        t.includes("processing") ||
        t.includes("uploading") ||
        t.includes("please wait")
      ) {
        return "busy";
      }
      if (hasAction) return "ready";
      return "wait";
    });
    if (state === "error") {
      throw new Error("Instagram rejected the video upload");
    }
    if (state === "ready") return;
    await delay(2000);
  }
};

/**
 * Instagram crop → filters → caption. Advance until caption/share UI appears.
 */
const advanceToCaption = async (page, extraSteps = 0) => {
  await logDialogStep(page);

  const max = 4 + extraSteps;
  for (let step = 1; step <= max; step++) {
    if (await onCaptionScreen(page)) {
      console.log(`✅ Caption screen ready (before Next #${step})`);
      return;
    }

    const required = step <= 2;
    const clicked = await clickNext(page, { required });
    await delay(videoWait(step));
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

const videoWait = (step) => (step <= 2 ? 8000 : 5000);

/** Confirm Instagram actually finished publishing (not just Share click). */
const waitForPostShared = async (page, videoPost) => {
  const phrases = [
    "your post has been shared",
    "post shared",
    "reel shared",
    "your reel has been shared",
    "your reel is shared",
    "shared to reels",
    "reel is now shared",
  ];

  const deadline = Date.now() + (videoPost ? 180000 : 90000);
  const started = Date.now();
  while (Date.now() < deadline) {
    const ok = await page.evaluate((list) => {
      const text = (document.body?.innerText || "").toLowerCase();
      return list.some((p) => text.includes(p));
    }, phrases);

    if (ok) {
      console.log("🚀 POST CONFIRMED — Instagram shared successfully");
      return true;
    }

    if (videoPost && Date.now() - started > 20000) {
      const dialogGone = await page.evaluate(
        () => !document.querySelector("div[role='dialog']")
      );
      if (dialogGone) {
        console.log("🚀 POST CONFIRMED — Instagram composer closed after share");
        return true;
      }
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
      throw new Error("No media provided for Instagram");
    }

    const lockFile = path.join(SESSION_DIR, "SingletonLock");
    if (fs.existsSync(lockFile)) {
      try {
        fs.unlinkSync(lockFile);
      } catch {}
    }

    const { label, executablePath, options: browserOpts } =
      resolveIgBrowserLaunch();
    console.log(
      `Instagram browser: ${label}${executablePath ? ` @ ${executablePath}` : ""} (session: ${SESSION_DIR})`
    );

    browser = await puppeteer.launch({
      headless: !isHeaded(),
      ...browserOpts,
      defaultViewport: { width: 1400, height: 1080, deviceScaleFactor: 1 },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=1400,1080",
        "--window-position=0,0",
        "--force-device-scale-factor=1",
        "--disable-session-crashed-bubble",
        "--hide-crash-restore-bubble",
        "--disable-infobars",
        "--noerrdialogs",
      ],
      userDataDir: SESSION_DIR,
    });
    assertEdgeProcess(browser);

    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1080, deviceScaleFactor: 1 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0"
    );

    await page.goto("https://www.instagram.com/?hl=en", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await delay(5000);
    try {
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      console.log("Instagram viewport DPR:", dpr);
    } catch {}

    await ensureLoggedIn(page);

    const media = Array.isArray(imageInputs)
      ? imageInputs.slice(0, 10)
      : [imageInputs];
    const videoPost = media.some(isVideoMedia);

    for (let i = 0; i < media.length; i++) {
      const uniqueName = `${Date.now()}_${i}_${Math.random()
        .toString(36)
        .substring(7)}`;

      if (isVideoMedia(media[i])) {
        const existing = resolveUploadPath(media[i]);
        if (existing) {
          imagePaths.push(existing);
        } else {
          const vidPath = path.resolve(`temp_${uniqueName}.mp4`);
          const saved = await saveMediaFile(media[i], vidPath);
          if (saved) imagePaths.push(saved);
        }
      } else {
        const imgPath = path.resolve(`temp_${uniqueName}.png`);
        const saved = await saveImage(media[i], imgPath);
        if (saved) imagePaths.push(imgPath);
      }
    }

    console.log("📦 Files ready:", imagePaths);

    if (imagePaths.length === 0) {
      throw new Error("Failed to prepare any Instagram media");
    }

    const plusAt = await clickPlusIcon(page);
    if (/\/reels\/?(\?|$)/i.test(page.url())) {
      console.log("Opened Reels feed by mistake — going Home");
      await page.goto("https://www.instagram.com/?hl=en", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await delay(3000);
      await clickPlusIcon(page);
    }

    // Plus may already open the composer or the Create flyout
    let createAt = plusAt;
    let mode = (await safeHas(page, "input[type='file']")) ? "post" : null;
    if (!mode) {
      mode = await pickComposerMode(page, videoPost, plusAt);
    }
    if (!mode) {
      createAt = await clickCreateMenu(page);
      await delay(1200);
      mode = await pickComposerMode(page, videoPost, createAt);
    }
    if (!mode) {
      const plusRetry = await clickPlusIcon(page);
      createAt = await clickCreateMenu(page);
      await delay(1200);
      mode = await pickComposerMode(page, videoPost, createAt || plusRetry);
    }
    await delay(1500);

    if (!videoPost && imagePaths.length > 1) {
      console.log("🟢 Enabling carousel mode...");
      await page.keyboard.down("Shift");
      await enableCarousel(page);
      await delay(4000);
    }

    try {
      await page.waitForSelector("input[type='file']", { timeout: 15000 });
    } catch {
      console.log("No file input yet — clicking Post/Reel again");
      await pickComposerMode(page, videoPost, createAt);
      await page.waitForSelector("input[type='file']", { timeout: 25000 });
    }
    const fileInput = await page.$("input[type='file']");
    const uploadFiles = videoPost ? imagePaths.slice(0, 1) : imagePaths;
    await fileInput.uploadFile(...uploadFiles);
    await page.keyboard.up("Shift");
    console.log(videoPost ? "✅ Video uploaded" : "✅ Images uploaded");

    await waitForUploadUi(page, videoPost);

    await advanceToCaption(page, videoPost ? 3 : 0);

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

    const confirmed = await waitForPostShared(page, videoPost);
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
    await delay(3000);
  }
};
