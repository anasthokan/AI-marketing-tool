import axios from "axios";
import dotenv from "dotenv";
import { HfInference } from "@huggingface/inference";

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

const hf = process.env.HF_TOKEN
  ? new HfInference(process.env.HF_TOKEN)
  : null;

const generateMockImages = (data) => {
  const count = Number(data.postsPerDay) || 1;
  const images = [];

  for (let i = 0; i < count; i++) {
    images.push(
      `https://picsum.photos/seed/${encodeURIComponent(
        `${data.company || "brand"}-${data.industry || "marketing"}-${i}`
      )}/600/400`
    );
  }

  console.log("🧪 SKIP_HF_IMAGES=true — using Picsum placeholders (no HF tokens)");
  return images;
};

const generateImages = async (data) => {
  if (skipHfImages()) {
    return generateMockImages(data);
  }

  if (!hf) {
    console.log("⚠️ HF_TOKEN missing — using mock images");
    return generateMockImages(data);
  }

  const images = [];
  const prompt = `${data.company} ${data.industry} marketing banner, high quality`;

  for (let i = 0; i < (Number(data.postsPerDay) || 1); i++) {
    try {
      const image = await hf.textToImage({
        model: "stabilityai/stable-diffusion-xl-base-1.0",
        inputs: prompt,
      });

      const buffer = Buffer.from(await image.arrayBuffer());
      const base64 = buffer.toString("base64");

      images.push(`data:image/png;base64,${base64}`);
      console.log("✅ HF SDK IMAGE");
    } catch (err) {
      console.log("❌ HF SDK ERROR:", err.message);
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
