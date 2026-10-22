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

  cron.schedule("* * * * *", async () => {
    if (running) {
      console.log("Scheduler still busy — skipping this minute");
      return;
    }
    running = true;

    try {
      if (mongoose.connection.readyState !== 1) {
        console.log("Scheduler skipped — MongoDB not connected");
        return;
      }

      const { todayDate, currentTime } = getNowParts(timeZone);
      console.log(`Scheduler tick ${todayDate} ${currentTime} (${timeZone})`);

      // One daily publish: older saved schedules were all firing every day.
      const post = await Post.findOne({
        scheduledTime: { $exists: true, $ne: null, $ne: "" },
        confirmed: { $ne: false },
        active: { $ne: false },
      }).sort({ createdAt: -1 });

      if (post) {
        const scheduled = normalizeTime(post.scheduledTime);
        if (!scheduled) return;

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
          return;
        }

        const dueNow = scheduled === currentTime;
        const missedToday = scheduled < currentTime && !sameDay;
        const failedAgo = post.lastPostAttemptAt
          ? Date.now() - new Date(post.lastPostAttemptAt).getTime()
          : Number.POSITIVE_INFINITY;
        const retryFailed =
          sameDay &&
          !allDone &&
          post.lastPostOk === false &&
          failedAgo >= 45 * 60 * 1000;
        if (!dueNow && !missedToday && !retryFailed) return;

        if (retryFailed) {
          console.log("Retrying platforms that failed today:", post._id, platformOk);
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
          return;
        }

        if (isVideo && !hasVideos) {
          console.log("Video post has no file — skipping:", post._id);
          return;
        }

        if (isVideo) {
          const missing = videos.filter((v) => !fs.existsSync(v));
          if (missing.length) {
            console.log("Video file missing on disk — skipping:", post._id, missing);
            post.lastPostOk = false;
            post.lastPostError = `Video file not found: ${missing[0]}`;
            await post.save();
            return;
          }
        }

        post.lastPostedDate = todayDate;
        post.lastPostAttemptAt = new Date();
        post.lastPostOk = false;
        post.scheduledTime = scheduled;
        if (!sameDay) {
          post.lastPlatformOk = {};
          post.markModified("lastPlatformOk");
        }
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
          alreadyOk: platformOk,
        });

        if (platforms.includes("Instagram")) {
          if (platformOk.Instagram) {
            console.log("Instagram already posted today — skipping");
            platformResults.Instagram = { success: true };
            anyOk = true;
          } else {
            const ig = await postToInstagramBot(caption, media);
            console.log("Instagram:", ig);
            await remember("Instagram", ig);
          }
        }

        if (platforms.includes("Facebook")) {
          if (platformOk.Facebook) {
            console.log("Facebook already posted today — skipping");
            platformResults.Facebook = { success: true };
            anyOk = true;
          } else {
            const fb = await postToFacebookBot(caption, media);
            console.log("Facebook:", fb);
            await remember("Facebook", fb);
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
