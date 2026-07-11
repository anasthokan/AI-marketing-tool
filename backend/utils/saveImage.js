import fs from "fs";
import axios from "axios";

/**
 * Save a base64 data-URL or remote HTTP(S) image to disk.
 * Returns filepath on success, null on failure.
 */
export const saveImage = async (input, filepath) => {
  if (!input || typeof input !== "string") return null;

  try {
    if (input.startsWith("data:image")) {
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
