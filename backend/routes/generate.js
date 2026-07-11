import express from "express";
import { generatePost } from "../services/aiService.js";
import Post from "../models/Post.js";
import { postToInstagramBot } from "../services/instagramBot.js";
import { postToFacebookBot } from "../services/facebookBot.js";

const router = express.Router();

router.get("/health", (_req, res) => {
  res.json({ ok: true, service: "ai-marketing-backend" });
});

router.post("/generate", async (req, res) => {
  try {
    const form = req.body;
    const platforms = Array.isArray(form.platform) ? form.platform : [];
    const postsPerDay = Math.min(Math.max(Number(form.postsPerDay) || 1, 1), 3);

    const result = await generatePost({ ...form, postsPerDay });

    console.log("AI RESULT:", result);

    const images =
      Array.isArray(result.images) && result.images.length > 0
        ? result.images
        : [];

    await Post.create({
      company: form.company,
      website: form.website,
      industry: form.industry,
      audience: form.audience,
      country: form.country,
      platform: platforms,
      posts: [result.text],
      images: result.images || [],
      scheduledTime: form.scheduledTime,
      postsPerDay,
    });

    const posting = {
      Instagram: platforms.includes("Instagram")
        ? { success: true, queued: true }
        : null,
      Facebook: platforms.includes("Facebook")
        ? { success: true, queued: true }
        : null,
    };

    // Respond immediately so mobile/other devices do not timeout
    // while Puppeteer bots run (can take several minutes).
    res.json({
      success: true,
      text: result.text,
      images: result.images || [],
      postsPerDay,
      scheduledTime: form.scheduledTime || null,
      platforms,
      posting,
      message: platforms.length
        ? "Content generated. Social posting started in background on server."
        : "Content generated and saved for schedule",
    });

    // Fire-and-forget after response is sent
    setImmediate(async () => {
      try {
        if (platforms.includes("Instagram")) {
          const ig = await postToInstagramBot(result.text, images);
          console.log("Instagram result:", ig);
        }
        if (platforms.includes("Facebook")) {
          const fb = await postToFacebookBot(result.text, images);
          console.log("Facebook result:", fb);
        }
      } catch (err) {
        console.error("Background post error:", err.message);
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

export default router;
