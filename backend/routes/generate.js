import express from "express";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { generatePost } from "../services/aiService.js";
import Post from "../models/Post.js";
import { normalizeTime } from "../scheduler/postScheduler.js";

const router = express.Router();

/** Persist manual uploads to disk — post exactly these files, no AI generation */
const saveManualUploadsToDisk = (images) => {
  const dir = path.resolve("uploads", "manual");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const saved = [];

  for (let i = 0; i < images.length; i++) {
    const raw = images[i];
    if (typeof raw !== "string" || !raw.trim()) continue;

    if (raw.startsWith("data:image")) {
      const matches = raw.match(/^data:image\/([\w+.-]+);base64,(.+)$/);
      if (!matches) continue;
      let ext = matches[1].toLowerCase().replace("jpeg", "jpg");
      if (ext.includes("png")) ext = "png";
      else if (ext.includes("webp")) ext = "webp";
      else if (ext.includes("gif")) ext = "gif";
      else ext = "jpg";
      const filepath = path.join(dir, `${stamp}_${i}.${ext}`);
      fs.writeFileSync(filepath, Buffer.from(matches[2], "base64"));
      saved.push(filepath);
    } else if (!/^https?:\/\//i.test(raw) && fs.existsSync(raw)) {
      saved.push(path.resolve(raw));
    }
  }

  return saved;
};

/** Browser-safe URL for files under uploads/ */
const toPreviewUrl = (filepath) => {
  if (!filepath || typeof filepath !== "string") return null;
  if (filepath.startsWith("data:") || /^https?:\/\//i.test(filepath)) {
    return filepath;
  }
  const uploadsRoot = path.resolve("uploads");
  const abs = path.resolve(filepath);
  const rel = path.relative(uploadsRoot, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return `/uploads/${rel.split(path.sep).join("/")}`;
};

router.get("/health", (_req, res) => {
  const mongoStates = ["disconnected", "connected", "connecting", "disconnecting"];
  const mongo = mongoStates[mongoose.connection.readyState] || "unknown";
  res.json({
    ok: true,
    service: "ai-marketing-backend",
    mongo,
    mongoReady: mongoose.connection.readyState === 1,
    scheduleTz: process.env.SCHEDULE_TZ || "Asia/Kolkata",
  });
});

router.post("/generate", async (req, res) => {
  req.setTimeout(600000);
  res.setTimeout(600000);

  try {
    const form = req.body;
    const isManual = form.mode === "manual";
    const platforms = Array.isArray(form.platform) ? form.platform : [];
    const postsPerDay = Math.min(Math.max(Number(form.postsPerDay) || 1, 1), 3);
    const scheduledTime = normalizeTime(form.scheduledTime || "");

    let result;

    if (isManual) {
      const caption = String(form.text || form.caption || "").trim();
      const uploaded = Array.isArray(form.images)
        ? form.images.filter((img) => typeof img === "string" && img.trim())
        : [];

      if (!caption) {
        return res.status(400).json({
          success: false,
          error: "Caption is required for manual posts",
        });
      }
      if (uploaded.length === 0) {
        return res.status(400).json({
          success: false,
          error: "At least one image is required for manual posts",
        });
      }

      // Save exact uploads to disk — never call AI image generation
      const images = saveManualUploadsToDisk(uploaded);
      if (images.length === 0) {
        return res.status(400).json({
          success: false,
          error: "Could not save uploaded images",
        });
      }

      result = { text: caption, images, cta: null };
      console.log("MANUAL RESULT (no AI):", {
        captionLength: caption.length,
        imageCount: images.length,
        paths: images,
      });
    } else {
      result = await generatePost({ ...form, postsPerDay });
      console.log("AI RESULT:", result);
    }

    let saved = false;
    let saveError = null;
    try {
      if (mongoose.connection.readyState === 1) {
        await Post.create({
          company: form.company,
          website: form.website,
          inquiryUrl: form.inquiryUrl || form.website,
          whatsapp: form.whatsapp,
          industry: form.industry,
          audience: form.audience,
          country: form.country,
          platform: platforms,
          posts: [result.text],
          images: result.images || [],
          source: isManual ? "manual" : "ai",
          scheduledTime,
          postsPerDay,
        });
        saved = true;
      } else {
        saveError = "MongoDB not connected (is mongod running on 27017?)";
        console.error(saveError);
      }
    } catch (dbErr) {
      saveError = dbErr.message;
      console.error("Post.save failed:", dbErr.message);
    }

    // Only schedule via cron — do not post immediately when a time is set.
    // (Immediate bots confused "Queued" with scheduled 10:35 posts.)
    const posting = {
      Instagram: platforms.includes("Instagram")
        ? { success: true, queued: true, mode: "scheduled" }
        : null,
      Facebook: platforms.includes("Facebook")
        ? { success: true, queued: true, mode: "scheduled" }
        : null,
      // LinkedIn: platforms.includes("LinkedIn")
      //   ? { success: true, queued: true, mode: "scheduled" }
      //   : null,
    };

    const actionLabel = isManual ? "Content" : "Content generated";
    const diskImages = result.images || [];
    const previewImages = isManual
      ? diskImages.map(toPreviewUrl).filter(Boolean)
      : diskImages;

    res.json({
      success: true,
      text: result.text,
      images: previewImages,
      cta: result.cta || null,
      mode: isManual ? "manual" : "ai",
      postsPerDay,
      scheduledTime: scheduledTime || null,
      platforms,
      posting,
      saved,
      saveError,
      message: saved
        ? `${isManual ? "Manual post" : "Content"} saved. Will post at ${scheduledTime} (${process.env.SCHEDULE_TZ || "Asia/Kolkata"}) via scheduler.`
        : `${actionLabel}, but not saved to DB: ${saveError || "MongoDB unavailable"}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

export default router;
