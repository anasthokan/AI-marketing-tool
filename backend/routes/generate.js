import express from "express";
import { generatePost } from "../services/aiService.js";
import Post from "../models/Post.js";
import { postToInstagramBot } from "../services/instagramBot.js";
import { postToFacebookBot } from "../services/facebookBot.js";

const router = express.Router();

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

    const posting = {
      Instagram: null,
      Facebook: null,
    };

    // Await bots so the UI gets real success/failure (not fire-and-forget)
    if (platforms.includes("Instagram")) {
      posting.Instagram = await postToInstagramBot(result.text, images);
    }

    if (platforms.includes("Facebook")) {
      posting.Facebook = await postToFacebookBot(result.text, images);
    }

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

    const anyPostFailed = Object.values(posting).some(
      (p) => p && p.success === false
    );

    res.json({
      success: !anyPostFailed,
      text: result.text,
      images: result.images || [],
      postsPerDay,
      scheduledTime: form.scheduledTime || null,
      platforms,
      posting,
      message: anyPostFailed
        ? "Content generated, but one or more social posts failed"
        : platforms.length
          ? "Content generated and posted"
          : "Content generated and saved for schedule",
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
