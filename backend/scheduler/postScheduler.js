import cron from "node-cron";
import Post from "../models/Post.js";
import { postToInstagramBot } from "../services/instagramBot.js";
import { postToFacebookBot } from "../services/facebookBot.js";
import { postToLinkedInBot } from "../services/linkedinBot.js";

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
      const { todayDate, currentTime } = getNowParts(timeZone);
      console.log(`Scheduler tick ${todayDate} ${currentTime} (${timeZone})`);

      const posts = await Post.find({
        scheduledTime: { $exists: true, $ne: null, $ne: "" },
      });

      for (const post of posts) {
        const scheduled = normalizeTime(post.scheduledTime);
        if (!scheduled || scheduled !== currentTime) continue;

        if (post.lastPostedDate === todayDate) {
          console.log("Already posted today:", post._id);
          continue;
        }

        // Claim immediately so next minute does not overlap
        post.lastPostedDate = todayDate;
        post.scheduledTime = scheduled;
        await post.save();

        console.log("DAILY POST TRIGGERED", {
          id: post._id,
          scheduled,
          platforms: post.platform,
          postsPerDay: post.postsPerDay,
        });

        const images =
          Array.isArray(post.images) && post.images.length > 0
            ? post.images
            : [`https://picsum.photos/400/300?random=${Date.now()}`];

        const caption = Array.isArray(post.posts)
          ? post.posts[0]
          : post.posts || "No caption";

        const totalPosts = Math.min(Math.max(Number(post.postsPerDay) || 1, 1), 3);
        const platforms = Array.isArray(post.platform) ? post.platform : [];

        for (let i = 0; i < totalPosts; i++) {
          console.log(`Posting ${i + 1}/${totalPosts}`);

          if (platforms.includes("Instagram")) {
            const ig = await postToInstagramBot(caption, images);
            console.log("Instagram:", ig);
          }

          if (platforms.includes("Facebook")) {
            const fb = await postToFacebookBot(caption, images);
            console.log("Facebook:", fb);
          }

          if (platforms.includes("LinkedIn")) {
            const li = await postToLinkedInBot(caption, images);
            console.log("LinkedIn:", li);
          }

          if (i < totalPosts - 1) {
            await new Promise((res) => setTimeout(res, 15000));
          }
        }

        post.posted = true;
        await post.save();
      }
    } catch (err) {
      console.log("Scheduler Error:", err.message);
    } finally {
      running = false;
    }
  });
};
