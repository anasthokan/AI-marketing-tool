import axios from "axios";
import fs from "fs";
import path from "path";

const mptBase = () => String(process.env.MPT_API_URL || "").replace(/\/$/, "");

export const isMptConfigured = () => Boolean(mptBase());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const downloadFile = async (url, dest) => {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 180000,
    validateStatus: (s) => s < 400,
  });
  fs.writeFileSync(dest, Buffer.from(res.data));
  return dest;
};

/**
 * Optional adapter for a running MoneyPrinterTurbo API
 * (python main.py — default http://127.0.0.1:8080).
 */
export const generateWithMoneyPrinter = async ({
  topic,
  script,
  language,
  aspect,
  voice,
  durationSec,
  outDir,
}) => {
  const base = mptBase();
  if (!base) throw new Error("MPT_API_URL is not set");

  const body = {
    video_subject: topic,
    video_script: script || "",
    video_language:
      language === "hi" ? "hi-IN" : language === "ar" ? "ar-SA" : "en-US",
    video_aspect: aspect === "16:9" ? "16:9" : "9:16",
    voice_name: voice,
    subtitle_enabled: true,
    bgm_type: "random",
    video_count: 1,
  };

  console.log("🎬 MoneyPrinterTurbo: creating task…");
  const created = await axios.post(`${base}/api/v1/videos`, body, {
    timeout: 30000,
  });
  const payload = created.data?.data || created.data || {};
  const taskId = payload.task_id;
  if (!taskId) {
    throw new Error("MoneyPrinterTurbo did not return a task_id");
  }

  const deadline = Date.now() + Number(process.env.MPT_TIMEOUT_MS || 480000);
  while (Date.now() < deadline) {
    const poll = await axios.get(`${base}/api/v1/tasks/${taskId}`, {
      timeout: 20000,
    });
    const data = poll.data?.data || poll.data || {};
    const state = data.state;
    const progress = data.progress;
    console.log(`🎬 MoneyPrinterTurbo task ${taskId}: state=${state} progress=${progress}`);

    if (state === 1) {
      const videos = data.videos || [];
      const first = videos[0];
      if (!first) throw new Error("MoneyPrinterTurbo finished with no video");
      const url = /^https?:\/\//i.test(first) ? first : `${base}${first}`;
      const dest = path.join(outDir, "final.mp4");
      await downloadFile(url, dest);
      return dest;
    }
    if (state === -1) {
      throw new Error(data.message || "MoneyPrinterTurbo task failed");
    }
    await sleep(4000);
  }

  throw new Error("MoneyPrinterTurbo timed out");
};
