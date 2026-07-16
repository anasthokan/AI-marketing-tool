/**
 * Build clickable CTA URLs for Website / Raise Inquiry / WhatsApp.
 */
export const normalizeUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
};

export const normalizeWhatsAppUrl = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return `https://wa.me/${digits}`;
};

export const buildCtaLinks = (data = {}) => {
  const website = normalizeUrl(data.website);
  const inquiry = normalizeUrl(data.inquiryUrl || data.website) || website;
  const whatsapp = normalizeWhatsAppUrl(data.whatsapp);

  return {
    website: website || null,
    inquiry: inquiry || null,
    whatsapp: whatsapp || null,
  };
};

/** Append CTA links to caption so FB/IG posts have real clickable URLs */
export const appendCtaToCaption = (text, data = {}) => {
  const links = buildCtaLinks(data);
  const lines = [];

  if (links.website) lines.push(`🌐 Website: ${links.website}`);
  if (links.inquiry) lines.push(`📩 Raise Inquiry: ${links.inquiry}`);
  if (links.whatsapp) lines.push(`💬 WhatsApp: ${links.whatsapp}`);

  if (lines.length === 0) return text || "";

  const base = String(text || "").trim();
  return `${base}\n\n──────────────\n${lines.join("\n")}`;
};
