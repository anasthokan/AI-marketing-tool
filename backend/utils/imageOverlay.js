import axios from "axios";
import sharp from "sharp";

const BUTTONS = [
  { id: "website", label: "Website", color: "#2563eb", textColor: "#ffffff" },
  { id: "inquiry", label: "Raise Inquiry", color: "#ea580c", textColor: "#ffffff" },
  { id: "whatsapp", label: "WhatsApp", color: "#25D366", textColor: "#ffffff" },
];

const toBuffer = async (input) => {
  if (!input || typeof input !== "string") {
    throw new Error("Invalid image input");
  }

  if (input.startsWith("data:image")) {
    const matches = input.match(/^data:(.+);base64,(.+)$/);
    if (!matches) throw new Error("Invalid base64 image");
    return Buffer.from(matches[2], "base64");
  }

  const res = await axios.get(input, {
    responseType: "arraybuffer",
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" },
    validateStatus: (status) => status < 400,
  });

  if (!res.data || res.data.length < 500) {
    throw new Error("Empty image response");
  }

  return Buffer.from(res.data);
};

const escapeXml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const buildCtaSvg = (width, barHeight) => {
  const padding = Math.round(width * 0.03);
  const gap = Math.round(width * 0.02);
  const btnWidth = Math.floor((width - padding * 2 - gap * 2) / 3);
  const btnHeight = Math.round(barHeight * 0.55);
  const btnY = Math.round((barHeight - btnHeight) / 2);
  const fontSize = Math.max(14, Math.round(btnHeight * 0.38));
  const radius = Math.round(btnHeight / 2);

  const buttonRects = BUTTONS.map((btn, i) => {
    const x = padding + i * (btnWidth + gap);
    return `
      <rect x="${x}" y="${btnY}" width="${btnWidth}" height="${btnHeight}"
        rx="${radius}" ry="${radius}" fill="${btn.color}" />
      <text x="${x + btnWidth / 2}" y="${btnY + btnHeight / 2 + fontSize * 0.35}"
        text-anchor="middle" font-family="Arial, Helvetica, sans-serif"
        font-size="${fontSize}" font-weight="700" fill="${btn.textColor}">
        ${escapeXml(btn.label)}
      </text>
    `;
  }).join("");

  return Buffer.from(`
    <svg width="${width}" height="${barHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${barHeight}" fill="rgba(0,0,0,0.72)" />
      ${buttonRects}
    </svg>
  `);
};

/**
 * Overlay Website / Raise Inquiry / WhatsApp CTA buttons on a marketing image.
 * Returns base64 data URL.
 */
export const addCtaButtons = async (imageInput, _cta = {}) => {
  const baseBuffer = await toBuffer(imageInput);
  const base = sharp(baseBuffer).rotate();
  const metadata = await base.metadata();

  const width = metadata.width || 1080;
  const height = metadata.height || 1080;
  const barHeight = Math.max(72, Math.round(height * 0.14));

  const ctaSvg = buildCtaSvg(width, barHeight);

  const output = await base
    .composite([{ input: ctaSvg, top: height - barHeight, left: 0 }])
    .png()
    .toBuffer();

  return `data:image/png;base64,${output.toString("base64")}`;
};

export const addCtaButtonsToAll = async (images, cta) => {
  if (!Array.isArray(images) || images.length === 0) return images;

  const results = [];
  for (const img of images) {
    try {
      results.push(await addCtaButtons(img, cta));
    } catch (err) {
      console.log("⚠️ CTA overlay failed, using original image:", err.message);
      results.push(img);
    }
  }
  return results;
};
