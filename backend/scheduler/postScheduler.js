import cron from "node-cron";
import fs from "fs";
import mongoose from "mongoose";
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
  let restoredSchedules = false;

  cron.schedule("* * * * *", async () => {
    if (running) {
      console.log("Scheduler still busy â€” skipping this minute");
      return;
    }
    running = true;

    try {
      if (mongoose.connection.readyState !== 1) {
        console.log("Scheduler skipped â€” MongoDB not connected");
        return;
      }

      const { todayDate, currentTime } = getNowParts(timeZone);
      console.log(`Scheduler tick ${todayDate} ${currentTime} (${timeZone})`);

      if (!restoredSchedules) {
        restoredSchedules = true;
        const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        const recentDay = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
          .toLocaleDateString("en-CA", { timeZone });
        const restored = await Post.updateMany(
          {
            active: false,
            confirmed: { $ne: false },
            scheduledTime: { $exists: true, $nin: [null, ""] },
            "images.0": { $exists: true },
            $or: [
              { createdAt: { $gte: since } },
              { lastPostedDate: { $gte: recentDay } },
            ],
          },
          { $set: { active: true } }
        );
        const restoredCount = restored.modifiedCount || restored.nModified || 0;
        if (restoredCount) {
          console.log(
            `Restored ${restoredCount} image schedule(s) so they publish with the video`
          );
        }
      }

      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const recentDay = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
        .toLocaleDateString("en-CA", { timeZone });
      const posts = await Post.find({
        scheduledTime: { $exists: true, $ne: null, $ne: "" },
        confirmed: { $ne: false },
        active: { $ne: false },
        $or: [
          { createdAt: { $gte: since } },
          { lastPostedDate: { $gte: recentDay } },
        ],
      }).sort({ createdAt: 1 });

      for (const post of posts) {
        const scheduled = normalizeTime(post.scheduledTime);
        if (!scheduled) continue;

        const sameDay = post.lastPostedDate === todayDate;
        const platformOk =
          sameDay &&
          post.lastPlatformOk &&
          typeof post.lastPlatformOk === "object"
            ? { ...post.lastPlatformOk }
            : {};
        const platforms = (
          Array.isArray(post.platform) ? post.platform : []
        ).filter((name) => name === "Instagram" || name === "Facebook");
        const allDone =
          platforms.length > 0 &&
          platforms.every((name) => platformOk[name] === true);

        if (sameDay && (post.lastPostOk === true || allDone)) {
          console.log("Already posted today:", post._id);
          continue;
        }

        // One attempt per saved post per day. A same-day retry was publishing
        // the Facebook video again after the first click had already gone out.
        const dueNow = scheduled === currentTime;
        const missedToday = scheduled < currentTime && !sameDay;
        if (!dueNow && !missedToday) continue;
        if (sameDay) continue;

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
            "Manual post has no uploaded images â€” skipping:",
            post._id
          );
          continue;
        }

        if (isVideo && !hasVideos) {
          console.log("Video post has no file â€” skipping:", post._id);
          continue;
        }

        if (isVideo) {
          const missing = videos.filter((v) => !fs.existsSync(v));
          if (missing.length) {
            console.log("Video file missing on disk â€” skipping:", post._id, missing);
            post.lastPostOk = false;
            post.lastPostError = `Video file not found: ${missing[0]}`;
            await post.save();
            continue;
          }
        }

        post.lastPostedDate = todayDate;
        post.lastPostAttemptAt = new Date();
        post.lastPostOk = false;
        post.scheduledTime = scheduled;
        post.lastPlatformOk = {};
        post.markModified("lastPlatformOk");
        await post.save();

        console.log("DAILY POST TRIGGERED", {
          id: post._id,
          scheduled,
          source: post.source || "ai",
          platforms: post.platform,
          imageCount: hasImages ? post.images.length : 0,
          videoCount: videos.length,
          catchUp: Boolean(missedToday && !dueNow),
        });

        const media = hasVideos
          ? videos
          : hasImages
            ? post.images
            : [`https://picsum.photos/400/300?random=${Date.now()}`];

        const caption = Array.isArray(post.posts)
          ? post.posts[0]
          : post.posts || "No caption";

        const platformResults = {};
        let anyOk = false;
        const remember = async (name, result) => {
          platformResults[name] = result;
          if (!result?.success) return;
          anyOk = true;
          platformOk[name] = true;
          post.lastPlatformOk = { ...platformOk };
          post.markModified("lastPlatformOk");
          await post.save();
        };

        console.log("Publishing once today", {
          id: post._id,
          platforms,
        });

        if (platforms.includes("Instagram")) {
          const ig = await postToInstagramBot(caption, media);
          console.log("Instagram:", ig);
          await remember("Instagram", ig);
        }

        if (platforms.includes("Facebook")) {
          const fb = await postToFacebookBot(caption, media);
          console.log("Facebook:", fb);
          await remember("Facebook", fb);
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

        await new Promise((res) => setTimeout(res, 8000));
      }
    } catch (err) {
      console.log("Scheduler Error:", err.message);
    } finally {
      running = false;
    }
  });
};
