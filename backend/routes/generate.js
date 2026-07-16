import express from "express";
import mongoose from "mongoose";
import { generatePost } from "../services/aiService.js";
import Post from "../models/Post.js";
import { normalizeTime } from "../scheduler/postScheduler.js";

const router = express.Router();

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
  try {
    const form = req.body;
    const platforms = Array.isArray(form.platform) ? form.platform : [];
    const postsPerDay = Math.min(Math.max(Number(form.postsPerDay) || 1, 1), 3);
    const scheduledTime = normalizeTime(form.scheduledTime || "");

    const result = await generatePost({ ...form, postsPerDay });

    console.log("AI RESULT:", result);

    const images =
      Array.isArray(result.images) && result.images.length > 0
        ? result.images
        : [];

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

    res.json({
      success: true,
      text: result.text,
      images: result.images || [],
      postsPerDay,
      scheduledTime: scheduledTime || null,
      platforms,
      posting,
      saved,
      saveError,
      message: saved
        ? `Content saved. Will post at ${scheduledTime} (${process.env.SCHEDULE_TZ || "Asia/Kolkata"}) via scheduler.`
        : `Content generated, but not saved to DB: ${saveError || "MongoDB unavailable"}`,
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
