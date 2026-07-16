import axios from "axios";
import dotenv from "dotenv";
import { InferenceClient } from "@huggingface/inference";
import { appendCtaToCaption, buildCtaLinks } from "../utils/ctaLinks.js";

dotenv.config();

const skipHfImages = () =>
  String(process.env.SKIP_HF_IMAGES || "").toLowerCase() === "true";

const imageSource = () =>
  String(process.env.IMAGE_SOURCE || "auto").trim().toLowerCase();

// ================= TEXT GENERATION (LLAMA3 LOCAL) =================
const generateText = async (data) => {
  try {
    const res = await axios.post(
      "http://localhost:11434/api/generate",
      {
        model: "llama3",
        prompt: `Generate marketing post for ${data.company} in ${data.industry} industry`,
        stream: false,
      },
      { timeout: 15000 }
    );

    return res.data.response;
  } catch (err) {
    console.log("TEXT ERROR:", err.message);
    return `🚀 ${data.company} - Grow your business today!`;
  }
};

const hfToken = (process.env.HF_TOKEN || "").trim();
const hf = hfToken ? new InferenceClient(hfToken) : null;

const imageModel =
  process.env.HF_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell";

const imageProviders = () => {
  const fromEnv = (process.env.HF_IMAGE_PROVIDER || "").trim();
  const defaults = ["together", "nscale", "fal-ai"];
  if (!fromEnv || fromEnv === "auto") return defaults;
  return [fromEnv, ...defaults.filter((p) => p !== fromEnv)];
};

const HF_IMAGE_TIMEOUT_MS = Number(process.env.HF_IMAGE_TIMEOUT_MS || 90000);
const POLLINATIONS_TIMEOUT_MS = Number(
  process.env.POLLINATIONS_TIMEOUT_MS || 120000
);

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);

const buildImagePrompt = (data, variation = 1) =>
  `Professional marketing banner for ${data.company}, ${data.industry} industry, high quality, clean modern design, vibrant colors, no text, variation ${variation}`;

/** Free AI images — no Hugging Face billing required */
const generatePollinationsImage = async (prompt, seed) => {
  const encoded = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=768&nologo=true&seed=${seed}`;

  console.log("🎨 Pollinations (free) image generation...");
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: POLLINATIONS_TIMEOUT_MS,
    headers: { "User-Agent": "Mozilla/5.0" },
    validateStatus: (status) => status < 400,
  });

  if (!res.data || res.data.length < 1000) {
    throw new Error("Empty Pollinations image response");
  }

  const mime = String(res.headers["content-type"] || "image/jpeg").split(";")[0];
  const base64 = Buffer.from(res.data).toString("base64");
  console.log("✅ Pollinations IMAGE OK");
  return `data:${mime};base64,${base64}`;
};

const picsumFallback = (i) =>
  `https://picsum.photos/600/400?random=${Date.now()}_${i}`;

const generateFreeImages = async (data, reason) => {
  const count = Number(data.postsPerDay) || 1;
  const images = [];

  for (let i = 0; i < count; i++) {
    try {
      images.push(
        await generatePollinationsImage(
          buildImagePrompt(data, i + 1),
          Date.now() + i
        )
      );
    } catch (err) {
      console.log("⚠️ Pollinations failed, Picsum fallback:", err.message);
      images.push(picsumFallback(i));
    }
  }

  console.log(`🆓 Free AI images via Pollinations — ${reason}`);
  return images;
};

const generateOneHfImage = async (prompt) => {
  let lastError = null;
  const providers = imageProviders().slice(0, 3);

  for (const provider of providers) {
    try {
      console.log(`🎨 HF image via provider=${provider} model=${imageModel}`);
      const image = await withTimeout(
        hf.textToImage({
          model: imageModel,
          inputs: prompt,
          provider,
        }),
        HF_IMAGE_TIMEOUT_MS,
        `HF ${provider}`
      );

      const buffer = Buffer.from(await image.arrayBuffer());
      const base64 = buffer.toString("base64");
      console.log(`✅ HF IMAGE OK (${provider})`);
      return `data:image/png;base64,${base64}`;
    } catch (err) {
      lastError = err;
      console.log(`❌ HF ERROR [${provider}]:`, err.message);
    }
  }

  throw lastError || new Error("All HF image providers failed");
};

const generateImages = async (data) => {
  const source = imageSource();

  if (source === "pollinations" || skipHfImages()) {
    return generateFreeImages(
      data,
      skipHfImages() ? "SKIP_HF_IMAGES=true" : "IMAGE_SOURCE=pollinations"
    );
  }

  if (!hf) {
    return generateFreeImages(data, "HF_TOKEN missing — using free Pollinations");
  }

  const images = [];
  const count = Number(data.postsPerDay) || 1;

  for (let i = 0; i < count; i++) {
    const prompt = buildImagePrompt(data, i + 1);
    try {
      if (source === "huggingface") {
        images.push(await generateOneHfImage(prompt));
      } else {
        // auto: try HF first, fall back to free Pollinations
        try {
          images.push(await generateOneHfImage(prompt));
        } catch (err) {
          console.log("❌ HF failed, falling back to Pollinations:", err.message);
          images.push(
            await generatePollinationsImage(prompt, Date.now() + i)
          );
        }
      }
    } catch (err) {
      console.log("❌ Image generation failed:", err.message);
      try {
        images.push(await generatePollinationsImage(prompt, Date.now() + i));
      } catch {
        images.push(picsumFallback(i));
      }
    }
  }

  return images;
};

// ================= MAIN FUNCTION =================
export const generatePost = async (data) => {
  const rawText = await generateText(data);
  // Caption gets real clickable links (FB/IG cannot click image buttons)
  const text = appendCtaToCaption(rawText, data);
  const cta = buildCtaLinks(data);
  const images = await generateImages(data);

  return { text, images, cta };
};
