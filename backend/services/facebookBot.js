import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { saveImage } from "../utils/saveImage.js";

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ================= MAIN BOT =================
export const postToFacebookBot = async (caption, imageInputs) => {
  let browser = null;
  const imagePaths = [];

  try {
    browser = await puppeteer.launch({
      headless: process.env.PUPPETEER_HEADLESS !== "false",
      defaultViewport: null,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--start-maximized"],
      userDataDir: "./facebook-session",
    });

    const page = await browser.newPage();

    await page.goto("https://www.facebook.com/", {
      waitUntil: "networkidle2",
    });

    await delay(6000);

    await page.waitForSelector("[aria-label='Create a post']");
    await page.click("[aria-label='Create a post']");
    console.log("✅ Post box opened");

    await delay(4000);

    const textbox = await page.waitForSelector("div[role='textbox']", {
      visible: true,
    });

    await textbox.click();
    await page.keyboard.type(caption, { delay: 20 });
    console.log("✅ Caption added");

    await delay(2000);

    if (imageInputs && imageInputs.length > 0) {
      for (let i = 0; i < imageInputs.length; i++) {
        const imgPath = path.resolve(`fb_${Date.now()}_${i}.png`);
        const saved = await saveImage(imageInputs[i], imgPath);
        if (saved) imagePaths.push(imgPath);
      }

      console.log("📦 Images ready:", imagePaths);

      if (imagePaths.length === 0) {
        throw new Error("Failed to prepare any Facebook images");
      }

      let fileInput;

      try {
        fileInput = await page.waitForSelector(
          "[role='dialog'] input[type='file']",
          { timeout: 5000 }
        );
        console.log("✅ Found existing file input");
      } catch {
        console.log("⚠️ Injecting file input...");

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

      await fileInput.uploadFile(...imagePaths);
      console.log("✅ Images uploaded");

      await page.waitForFunction(() => {
        const dialog = document.querySelector("[role='dialog']");
        if (!dialog) return false;
        return dialog.querySelectorAll("img").length > 0;
      });

      console.log("🖼️ Image attached confirmed");
      await delay(4000);
    }

    await delay(3000);

    const postBtn = await page.waitForSelector(
      "[role='dialog'] div[aria-label='Post']",
      { visible: true }
    );

    const isDisabled = await page.evaluate((btn) => {
      return btn.getAttribute("aria-disabled") === "true";
    }, postBtn);

    if (isDisabled) {
      throw new Error("Post button is disabled");
    }

    await postBtn.click({ delay: 100 });
    console.log("🚀 REAL POST CLICKED");

    await page.waitForFunction(() => {
      return !document.querySelector("[role='dialog']");
    }, { timeout: 60000 });

    console.log("✅ POST SUCCESSFULLY DONE");

    await page.waitForSelector("[aria-label='Create a post']", {
      timeout: 60000,
    });

    console.log("✅ POST CONFIRMED");
    await delay(5000);

    return { success: true };
  } catch (err) {
    console.log("❌ ERROR:", err.message);
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