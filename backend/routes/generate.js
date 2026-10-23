import express from "express";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { randomUUID } from "crypto";
import { generatePost } from "../services/aiService.js";
import { generateShortVideo } from "../services/videoService.js";
import { getFfmpegPath } from "../utils/ffmpeg.js";
import {
  createVideoJob,
  updateVideoJob,
  getVideoJob,
} from "../utils/videoProgress.js";
import Post from "../models/Post.js";
import { normalizeTime } from "../scheduler/postScheduler.js";
import { getUploadsRoot } from "../utils/paths.js";

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
  const uploadsRoot = getUploadsRoot();
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
    ffmpeg: Boolean(getFfmpegPath()),
    mpt: Boolean(String(process.env.MPT_API_URL || "").trim()),
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
          postsPerDay: 1,
          active: true,
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

router.post("/generate-video", async (req, res) => {
  try {
    const form = req.body;
    const topic = String(form.topic || form.videoSubject || "").trim();
    if (!topic) {
      return res.status(400).json({
        success: false,
        error: "Video topic is required",
      });
    }

    const platforms = Array.isArray(form.platform) ? form.platform : [];
    const postsPerDay = Math.min(Math.max(Number(form.postsPerDay) || 1, 1), 3);
    const scheduledTime = normalizeTime(form.scheduledTime || "");
    const targetSec = Math.min(
      60,
      Math.max(10, Math.round(Number(form.duration) || 15))
    );
    const jobId = String(form.jobId || "").trim() || randomUUID();

    createVideoJob(jobId);
    updateVideoJob(jobId, {
      progress: 3,
      stage: "script",
      label: "Starting…",
      status: "running",
    });

    console.log("VIDEO GENERATE (async):", {
      topic,
      targetSec,
      platforms,
      scheduledTime,
      jobId,
    });

    // Return immediately so IIS/ARR does not 502 on a 5–10 min render.
    res.json({
      success: true,
      jobId,
      status: "running",
      message: "Video generation started",
    });

    setImmediate(async () => {
      try {
        const result = await generateShortVideo({
          ...form,
          topic,
          duration: targetSec,
          postsPerDay,
          onProgress: (progress, stage, label) => {
            updateVideoJob(jobId, {
              progress,
              stage,
              label,
              status: "running",
            });
          },
        });

        const diskVideo =
          result.video || (result.videos && result.videos[0]) || null;
        const previewVideo = diskVideo ? toPreviewUrl(diskVideo) : null;
        updateVideoJob(jobId, {
          progress: 100,
          stage: "finish",
          label: "Video ready",
          status: "done",
          diskVideo,
          result: {
            success: true,
            text: result.text,
            script: result.script,
            video: previewVideo,
            videos: previewVideo ? [previewVideo] : [],
            images: [],
            cta: result.cta || null,
            mode: "video",
            duration: targetSec,
            postsPerDay,
            scheduledTime: scheduledTime || null,
            platforms,
            posting: {},
            saved: false,
            needsConfirm: true,
            message: `Preview ready (${targetSec}s). Watch the video, then confirm if you want to post.`,
          },
        });
      } catch (err) {
        console.error("VIDEO JOB FAILED:", err);
        updateVideoJob(jobId, {
          status: "error",
          label: err.message,
          stage: "finish",
          error: err.message,
        });
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

router.get("/video-progress/:jobId", (req, res) => {
  const job = getVideoJob(String(req.params.jobId || "").trim());
  if (!job) {
    return res.json({
      progress: 0,
      stage: "script",
      label: "Waiting…",
      status: "running",
    });
  }
  const { diskVideo, ...safe } = job;
  res.json(safe);
});

const resolveConfirmVideoPath = (input) => {
  if (!input || typeof input !== "string") return null;
  let rel = input.trim().replace(/^https?:\/\/[^/]+/i, "");
  if (rel.startsWith("/uploads/")) rel = rel.slice(1);
  rel = rel.replace(/\\/g, "/").replace(/^\//, "");
  if (!rel.startsWith("uploads/")) return null;

  const uploadsRoot = getUploadsRoot();
  const videosRoot = path.join(uploadsRoot, "videos");
  const candidates = [
    path.resolve(rel),
    path.join(uploadsRoot, rel.replace(/^uploads\//, "")),
  ];

  for (const abs of candidates) {
    const inside = path.relative(videosRoot, abs);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) continue;
    if (fs.existsSync(abs)) return abs;
  }
  return null;
};

router.post("/confirm-video", async (req, res) => {
  try {
    const form = req.body;
    const platforms = Array.isArray(form.platform) ? form.platform : [];
    const postsPerDay = Math.min(Math.max(Number(form.postsPerDay) || 1, 1), 3);
    const scheduledTime = normalizeTime(form.scheduledTime || "");
    const jobId = String(form.jobId || "").trim();
    const job = jobId ? getVideoJob(jobId) : null;
    let videoFile =
      job?.diskVideo && fs.existsSync(job.diskVideo) ? job.diskVideo : null;
    if (!videoFile) videoFile = resolveConfirmVideoPath(form.video);

    let caption = String(form.text || form.caption || "").trim();
    if (!caption) caption = String(job?.result?.text || "").trim();

    if (!videoFile) {
      return res.status(400).json({
        success: false,
        error:
          "Saved video file was not found on the server. Click No, then generate once more.",
      });
    }
    if (!caption) {
      return res.status(400).json({
        success: false,
        error: "Caption is missing. Type a caption, then click Yes again.",
      });
    }
    if (!platforms.length) {
      return res.status(400).json({
        success: false,
        error: "Select at least one platform",
      });
    }
    if (!scheduledTime) {
      return res.status(400).json({
        success: false,
        error: "Please select post time",
      });
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
          posts: [caption],
          images: [],
          videos: [videoFile],
          source: "video",
          confirmed: true,
          scheduledTime,
          postsPerDay: 1,
          active: true,
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

    const posting = {
      Instagram: platforms.includes("Instagram")
        ? { success: true, queued: true, mode: "scheduled" }
        : null,
      Facebook: platforms.includes("Facebook")
        ? { success: true, queued: true, mode: "scheduled" }
        : null,
    };

    res.json({
      success: saved,
      text: caption,
      video: toPreviewUrl(videoFile),
      videos: [toPreviewUrl(videoFile)].filter(Boolean),
      images: [],
      mode: "video",
      postsPerDay,
      scheduledTime,
      platforms,
      posting,
      saved,
      saveError,
      needsConfirm: false,
      message: saved
        ? `Confirmed. Will post at ${scheduledTime} (${process.env.SCHEDULE_TZ || "Asia/Kolkata"}) via scheduler.`
        : `Could not save: ${saveError || "MongoDB unavailable"}`,
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
