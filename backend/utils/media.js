import fs from "fs";
import path from "path";
import axios from "axios";

const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;

export const isVideoMedia = (item) => {
  if (!item || typeof item !== "string") return false;
  if (item.startsWith("data:video")) return true;
  return VIDEO_EXT.test(item.split("?")[0]);
};

export const saveMediaFile = async (input, destPath) => {
  if (!input || typeof input !== "string") return null;

  if (input.startsWith("data:")) {
    const matches = input.match(/^data:(.+);base64,(.+)$/);
    if (!matches) return null;
    fs.writeFileSync(destPath, Buffer.from(matches[2], "base64"));
    return destPath;
  }

  if (/^https?:\/\//i.test(input)) {
    const res = await axios.get(input, {
      responseType: "arraybuffer",
      timeout: 120000,
      headers: { "User-Agent": "Mozilla/5.0" },
      validateStatus: (status) => status < 400,
    });
    if (!res.data || res.data.length < 1000) return null;
    fs.writeFileSync(destPath, Buffer.from(res.data));
    return destPath;
  }

  const src = path.resolve(input);
  if (!fs.existsSync(src)) return null;
  if (path.resolve(destPath) !== src) {
    fs.copyFileSync(src, destPath);
  }
  return destPath;
};
