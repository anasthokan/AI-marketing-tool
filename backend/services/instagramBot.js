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
  for (let i = 0; i < 5; i++) {
    try {
      const btn = await page.waitForSelector("svg[aria-label='New post']", {
        timeout: 5000,
      });

      await btn.click();
      console.log("✅ Create clicked");
      return;
    } catch {}

    await delay(2000);
  }

  throw new Error("❌ Create button not found");
};

// ================= CLICK NEXT =================
const clickNext = async (page) => {
  for (let i = 0; i < 10; i++) {
    try {
      const found = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll("*"));

        const el = elements.find(
          (e) =>
            e.innerText &&
            e.innerText.trim().toLowerCase() === "next"
        );

        if (el) {
          const rect = el.getBoundingClientRect();

          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        }

        return null;
      });

      if (found) {
        await page.mouse.click(found.x, found.y);
        console.log("✅ Next clicked");
        return;
      }
    } catch {}

    await delay(2000);
  }

  throw new Error("❌ Next button not found");
};

// ================= CLICK SHARE =================
const clickShare = async (page) => {
  for (let i = 0; i < 10; i++) {
    const found = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll("*"));

      const el = elements.find(
        (e) =>
          e.innerText &&
          e.innerText.trim().toLowerCase() === "share"
      );

      if (el) {
        const rect = el.getBoundingClientRect();

        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }

      return null;
    });

    if (found) {
      await page.mouse.click(found.x, found.y);
      console.log("🚀 POSTED SUCCESSFULLY");
      return;
    }

    await delay(2000);
  }

  throw new Error("❌ Share button not found");
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
      defaultViewport: null,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--start-maximized"],
      userDataDir: SESSION_DIR,
    });

    const page = await browser.newPage();

    await page.goto("https://www.instagram.com/", {
      waitUntil: "networkidle2",
    });

    await delay(8000);

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

    await clickNext(page);
    await delay(4000);

    await clickNext(page);
    await delay(4000);

    await page.waitForSelector("textarea, div[role='textbox']", {
      timeout: 30000,
    });

    const box =
      (await page.$("textarea")) || (await page.$("div[role='textbox']"));

    await box.click();
    await page.keyboard.type(caption, { delay: 20 });
    console.log("✅ Caption added");

    await delay(3000);
    await clickShare(page);

    console.log("⏳ Waiting before closing...");
    await delay(15000);

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
  }
};