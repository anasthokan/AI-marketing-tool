import axios from "axios";
import dotenv from "dotenv";
import { InferenceClient } from "@huggingface/inference";

dotenv.config();

const skipHfImages = () =>
  String(process.env.SKIP_HF_IMAGES || "").toLowerCase() === "true";

// ================= TEXT GENERATION (LLAMA3 LOCAL) =================
const generateText = async (data) => {
  try {
    const res = await axios.post("http://localhost:11434/api/generate", {
      model: "llama3",
      prompt: `Generate marketing post for ${data.company} in ${data.industry} industry`,
      stream: false,
    });

    return res.data.response;
  } catch (err) {
    console.log("TEXT ERROR:", err.message);
    return `🚀 ${data.company} - Grow your business today!`;
  }
};

const hfToken = (process.env.HF_TOKEN || "").trim();
const hf = hfToken ? new InferenceClient(hfToken) : null;

/** Model that supports text-to-image on multiple HF providers */
const imageModel =
  process.env.HF_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell";

/**
 * Preferred providers (env first). fal-ai often needs billing credits;
 * together / nscale / hf-inference are tried as fallbacks.
 */
const imageProviders = () => {
  const fromEnv = (process.env.HF_IMAGE_PROVIDER || "").trim();
  const defaults = ["together", "nscale", "fal-ai", "replicate", "hf-inference"];
  if (!fromEnv || fromEnv === "auto") return defaults;
  return [fromEnv, ...defaults.filter((p) => p !== fromEnv)];
};

const generateMockImages = (data, reason) => {
  const count = Number(data.postsPerDay) || 1;
  const images = [];

  for (let i = 0; i < count; i++) {
    images.push(
      `https://picsum.photos/seed/${encodeURIComponent(
        `${data.company || "brand"}-${data.industry || "marketing"}-${i}`
      )}/600/400`
    );
  }

  console.log(`🧪 Using Picsum placeholders — ${reason}`);
  return images;
};

const generateOneImage = async (prompt) => {
  let lastError = null;

  for (const provider of imageProviders()) {
    try {
      console.log(`🎨 HF image via provider=${provider} model=${imageModel}`);
      const image = await hf.textToImage({
        model: imageModel,
        inputs: prompt,
        provider,
      });

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
  if (skipHfImages()) {
    return generateMockImages(data, "SKIP_HF_IMAGES=true");
  }

  if (!hf) {
    return generateMockImages(
      data,
      "HF_TOKEN missing — set a fine-grained token with Inference Providers permission"
    );
  }

  const images = [];
  const prompt = `Professional marketing banner for ${data.company}, ${data.industry} industry, high quality, clean design, no text`;

  for (let i = 0; i < (Number(data.postsPerDay) || 1); i++) {
    try {
      images.push(await generateOneImage(`${prompt}, variation ${i + 1}`));
    } catch (err) {
      console.log("❌ HF ALL PROVIDERS FAILED:", err.message);
      console.log(
        "Fix: 1) hf.co/settings/tokens → enable 'Make calls to Inference Providers' 2) hf.co/settings/billing → need credits 3) set HF_IMAGE_PROVIDER=together"
      );
      images.push(
        `https://picsum.photos/600/400?random=${Date.now()}_${i}`
      );
    }
  }

  return images;
};

// ================= MAIN FUNCTION =================
export const generatePost = async (data) => {
  const text = await generateText(data);
  const images = await generateImages(data);

  return { text, images };
};
