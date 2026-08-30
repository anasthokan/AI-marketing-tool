import cron from "node-cron";
import fs from "fs";
import Post from "../models/Post.js";
import { postToInstagramBot } from "../services/instagramBot.js";
import { postToFacebookBot } from "../services/facebookBot.js";
// import { postToLinkedInBot } from "../services/linkedinBot.js";

/** Normalize "9:05", "09:05:00" -> "09:05" */
export const normalizeTime = (value) => {
  if (!value || typeof value !== "string") return "";
  const parts = value.trim().split(":");
  if (parts.length < 2) return "";
  const h = String(Number(parts[0])).padStart(2, "0");
  const m = String(Number(parts[1])).padStart(2, "0");
  if (Number.isNaN(Number(h)) || Number.isNaN(Number(m))) return "";
  return `${h}:${m}`;
};

const getNowParts = (timeZone) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const todayDate = `${map.year}-${map.month}-${map.day}`;
  const currentTime = `${map.hour}:${map.minute}`;
  return { todayDate, currentTime: normalizeTime(currentTime) };
};

export const startScheduler = () => {
  const timeZone = process.env.SCHEDULE_TZ || "Asia/Kolkata";
  console.log(`Scheduler using timezone: ${timeZone}`);

  let running = false;
  let retriedLegacyVideo = false;

  cron.schedule("* * * * *", async () => {
    if (running) {
      console.log("Scheduler still busy — skipping this minute");
      return;
    }
    running = true;

    try {
      if (!retriedLegacyVideo) {
        retriedLegacyVideo = true;
        const reset = await Post.updateMany(
          { source: "video", lastPostOk: { $exists: false } },
          {
            $set: {
              posted: false,
              lastPostedDate: null,
              lastPostError: "retry-video-upload",
            },
          }
        );
        if (reset.modifiedCount || reset.nModified) {
          console.log(
            `Reset ${reset.modifiedCount || reset.nModified} video post(s) that were marked posted without a real upload result`
          );
        }
      }

      const { todayDate, currentTime } = getNowParts(timeZone);
      console.log(`Scheduler tick ${todayDate} ${currentTime} (${timeZone})`);

      const posts = await Post.find({
        scheduledTime: { $exists: true, $ne: null, $ne: "" },
      });

      for (const post of posts) {
        const scheduled = normalizeTime(post.scheduledTime);
        if (!scheduled) continue;

        const alreadyTriedToday =
          post.lastPostedDate === todayDate && post.lastPostOk !== false;
        if (alreadyTriedToday) {
          console.log("Already posted today:", post._id);
          continue;
        }

        const dueNow = scheduled === currentTime;
        const missedUnpublished =
          scheduled < currentTime &&
          post.lastPostedDate !== todayDate &&
          post.lastPostOk !== true;
        if (!dueNow && !missedUnpublished) continue;

        if (post.lastPostedDate === todayDate && post.lastPostOk === false) {
          console.log("Video post failed earlier today — waiting until tomorrow:", post._id);
          continue;
        }

        if (post.confirmed === false) {
          console.log("Post not confirmed by user — skipping:", post._id);
          continue;
        }

        const isManual = post.source === "manual";
        const isVideo = post.source === "video";
        const hasImages =
          Array.isArray(post.images) && post.images.length > 0;
        const videos = Array.isArray(post.videos)
          ? post.videos.filter(Boolean)
          : [];
        const hasVideos = videos.length > 0;

        if (isManual && !hasImages) {
          console.log(
            "Manual post has no uploaded images — skipping:",
            post._id
          );
          continue;
        }

        if (isVideo && !hasVideos) {
          console.log("Video post has no file — skipping:", post._id);
          continue;
        }

        if (isVideo) {
          const missing = videos.filter((v) => !fs.existsSync(v));
          if (missing.length) {
            console.log("Video file missing on disk — skipping:", post._id, missing);
            post.lastPostOk = false;
            post.lastPostError = `Video file not found: ${missing[0]}`;
            await post.save();
            continue;
          }
        }

        post.lastPostedDate = todayDate;
        post.scheduledTime = scheduled;
        await post.save();

        console.log("DAILY POST TRIGGERED", {
          id: post._id,
          scheduled,
          source: post.source || "ai",
          platforms: post.platform,
          postsPerDay: post.postsPerDay,
          imageCount: hasImages ? post.images.length : 0,
          videoCount: videos.length,
          catchUp: Boolean(missedUnpublished && !dueNow),
        });

        const media = hasVideos
          ? videos
          : hasImages
            ? post.images
            : [`https://picsum.photos/400/300?random=${Date.now()}`];

        const caption = Array.isArray(post.posts)
          ? post.posts[0]
          : post.posts || "No caption";

        const totalPosts = Math.min(Math.max(Number(post.postsPerDay) || 1, 1), 3);
        const platforms = Array.isArray(post.platform) ? post.platform : [];

        const platformResults = {};
        let anyOk = false;

        for (let i = 0; i < totalPosts; i++) {
          console.log(`Posting ${i + 1}/${totalPosts}`);

          if (platforms.includes("Instagram")) {
            const ig = await postToInstagramBot(caption, media);
            console.log("Instagram:", ig);
            platformResults.Instagram = ig;
            if (ig?.success) anyOk = true;
          }

          if (platforms.includes("Facebook")) {
            const fb = await postToFacebookBot(caption, media);
            console.log("Facebook:", fb);
            platformResults.Facebook = fb;
            if (fb?.success) anyOk = true;
          }

          if (i < totalPosts - 1) {
            await new Promise((res) => setTimeout(res, 15000));
          }
        }

        const failParts = Object.entries(platformResults)
          .filter(([, r]) => !r?.success)
          .map(([name, r]) => `${name}: ${r?.error || "failed"}`);

        post.lastPostOk = anyOk && failParts.length === 0;
        post.lastPostError = failParts.length ? failParts.join(" | ") : null;
        post.posted = anyOk;
        await post.save();

        if (!anyOk) {
          console.log("Post did not publish on any platform:", post._id, post.lastPostError);
        }
      }
    } catch (err) {
      console.log("Scheduler Error:", err.message);
    } finally {
      running = false;
    }
  });
};
