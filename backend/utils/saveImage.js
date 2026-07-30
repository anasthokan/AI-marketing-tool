import fs from "fs";
import path from "path";
import axios from "axios";

/**
 * Save a base64 data-URL, remote HTTP(S) URL, or local file path to disk.
 * Returns filepath on success, null on failure.
 *
 * Never replaces user-uploaded images (data URLs / local files) with random fallbacks.
 * Picsum fallback is only for failed remote HTTP URLs (AI mode).
 */
export const saveImage = async (input, filepath, options = {}) => {
  if (!input || typeof input !== "string") return null;

  const isDataUrl = input.startsWith("data:image");
  const isRemoteUrl = /^https?:\/\//i.test(input);
  const isLocalFile = !isDataUrl && !isRemoteUrl;
  // Manual / exact uploads must never become a random Picsum image
  const allowFallback =
    options.allowFallback !== undefined
      ? options.allowFallback
      : isRemoteUrl;

  try {
    if (isLocalFile) {
      const src = path.resolve(input);
      if (!fs.existsSync(src)) {
        throw new Error(`Local image not found: ${src}`);
      }
      if (path.resolve(filepath) !== src) {
        fs.copyFileSync(src, filepath);
      }
      console.log("✅ Local image ready:", filepath);
      return filepath;
    }

    if (isDataUrl) {
      const matches = input.match(/^data:(.+);base64,(.+)$/);
      if (!matches) throw new Error("Invalid base64 image");

      fs.writeFileSync(filepath, Buffer.from(matches[2], "base64"));
      console.log("✅ Base64 image saved:", filepath);
      return filepath;
    }

    const res = await axios.get(input, {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: { "User-Agent": "Mozilla/5.0" },
      validateStatus: (status) => status < 400,
    });

    if (!res.data || res.data.length < 1000) {
      throw new Error("Invalid or empty image response");
    }

    fs.writeFileSync(filepath, Buffer.from(res.data));
    console.log("✅ URL image saved:", filepath);
    return filepath;
  } catch (err) {
    console.log("❌ Image save failed:", err.message);

    if (!allowFallback) {
      return null;
    }

    try {
      const fallback = `https://picsum.photos/600/400?random=${Date.now()}`;
      const res = await axios.get(fallback, {
        responseType: "arraybuffer",
        timeout: 15000,
      });
      fs.writeFileSync(filepath, Buffer.from(res.data));
      console.log("⚠️ Fallback image used:", filepath);
      return filepath;
    } catch (fallbackErr) {
      console.log("❌ Fallback also failed:", fallbackErr.message);
      return null;
    }
  }
};
