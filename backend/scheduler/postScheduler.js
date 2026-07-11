import cron from "node-cron";
import Post from "../models/Post.js";
import { postToInstagramBot } from "../services/instagramBot.js";
import { postToFacebookBot } from "../services/facebookBot.js";

export const startScheduler = () => {
  cron.schedule("* * * * *", async () => {
    try {
      const now = new Date();

      const currentTime = now.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      const todayDate = now.toISOString().split("T")[0];

      const posts = await Post.find({
        scheduledTime: currentTime,
      });

      for (const post of posts) {
        if (post.lastPostedDate === todayDate) {
          console.log("⏭️ Already posted today");
          continue;
        }

        console.log("🔥 DAILY POST TRIGGERED");

        const images =
          Array.isArray(post.images) && post.images.length > 0
            ? post.images
            : [`https://picsum.photos/400/300?random=${Date.now()}`];

        const caption = Array.isArray(post.posts)
          ? post.posts[0]
          : post.posts || "No caption";

        const totalPosts = Math.min(Math.max(Number(post.postsPerDay) || 1, 1), 3);
        const platforms = Array.isArray(post.platform) ? post.platform : [];

        console.log("🧠 Images:", images.length);
        console.log("🧠 Posts/day:", totalPosts);
        console.log("🧠 Platforms:", platforms);

        for (let i = 0; i < totalPosts; i++) {
          console.log(`🚀 Posting ${i + 1}/${totalPosts}`);

          if (platforms.includes("Instagram")) {
            const ig = await postToInstagramBot(caption, images);
            console.log("Instagram:", ig);
          }

          if (platforms.includes("Facebook")) {
            const fb = await postToFacebookBot(caption, images);
            console.log("Facebook:", fb);
          }

          if (i < totalPosts - 1) {
            await new Promise((res) => setTimeout(res, 20000));
          }
        }

        post.lastPostedDate = todayDate;
        post.posted = true;
        await post.save();
      }
    } catch (err) {
      console.log("❌ Scheduler Error:", err.message);
    }
  });
};
