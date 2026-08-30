import fs from "fs";
import path from "path";
import axios from "axios";
import { EdgeTTS } from "node-edge-tts";
import { appendCtaToCaption, buildCtaLinks } from "../utils/ctaLinks.js";
import {
  runFfmpeg,
  probeDuration,
  escapeSubtitlesPath,
} from "../utils/ffmpeg.js";
import {
  generateWithMoneyPrinter,
  isMptConfigured,
} from "./mptClient.js";
import { getUploadsRoot } from "../utils/paths.js";

const VOICES = {
  "en-female": { voice: "en-US-AriaNeural", lang: "en-US" },
  "en-male": { voice: "en-US-GuyNeural", lang: "en-US" },
  "en-in": { voice: "en-IN-NeerjaNeural", lang: "en-IN" },
  "hi-female": { voice: "hi-IN-SwaraNeural", lang: "hi-IN" },
  "hi-male": { voice: "hi-IN-MadhurNeural", lang: "hi-IN" },
  "ar-female": { voice: "ar-SA-ZariyahNeural", lang: "ar-SA" },
  "ar-male": { voice: "ar-SA-HamedNeural", lang: "ar-SA" },
};

const voiceLangPrefix = (voice) => {
  const key = String(voice || "");
  if (key.startsWith("hi")) return "hi";
  if (key.startsWith("ar")) return "ar";
  return "en";
};

const resolveNarrationLanguage = (language, voice) => {
  const fromVoice = voiceLangPrefix(voice);
  if (fromVoice === "hi" || language === "hi") return "hi";
  if (fromVoice === "ar" || language === "ar") return "ar";
  return "en";
};

const defaultVoiceForLanguage = (language) => {
  if (language === "hi") return "hi-male";
  if (language === "ar") return "ar-male";
  return "en-in";
};

const mptVoiceFor = (language, voice) => {
  if (String(voice || "").startsWith("hi")) return "hi-IN-MadhurNeural";
  if (String(voice || "").startsWith("ar")) return "ar-SA-HamedNeural";
  if (language === "hi") return "hi-IN-SwaraNeural";
  if (language === "ar") return "ar-SA-ZariyahNeural";
  return "en-IN-NeerjaNeural";
};

const looksLikeHindi = (text) => {
  const hindi = (String(text).match(/[\u0900-\u097F]/g) || []).length;
  const latin = (String(text).match(/[A-Za-z]/g) || []).length;
  return hindi >= 20 && hindi >= latin;
};

const looksLikeArabic = (text) => {
  const arabic = (String(text).match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (String(text).match(/[A-Za-z]/g) || []).length;
  return arabic >= 20 && arabic >= latin;
};

const sizeForAspect = (aspect) =>
  aspect === "16:9" ? { width: 1280, height: 720 } : { width: 720, height: 1280 };

const H264_COMPAT = [
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-preset",
  "veryfast",
  "-profile:v",
  "main",
  "-level",
  "4.0",
  "-crf",
  "23",
  "-maxrate",
  "2M",
  "-bufsize",
  "4M",
  "-movflags",
  "+faststart",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ollamaUrl = () =>
  String(process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/$/, "");

const generateScript = async ({
  topic,
  company,
  industry,
  language,
  customScript,
  durationSec,
}) => {
  const trimmed = String(customScript || "").trim();
  if (trimmed) return trimmed;

  const seconds = Number(durationSec) > 0 ? Number(durationSec) : 15;
  const hindi = language === "hi";
  const arabic = language === "ar";
  const words = Math.max(20, Math.round(seconds * 2.4));
  const langRule = hindi
    ? "Language: Hindi. Write the ENTIRE narration in Hindi Devanagari (हिन्दी). No English sentences. Brand names may stay in English. Do not use Hinglish or Roman Hindi."
    : arabic
      ? "Language: Arabic. Write the ENTIRE narration in Arabic script (العربية). No English sentences. Brand names may stay in English. Do not transliterate Arabic into Latin letters."
      : "Language: English.";
  const prompt = [
    `Write a spoken narration for a ${seconds}-second social video.`,
    `Topic: ${topic}`,
    company ? `Brand: ${company}` : "",
    industry ? `Industry: ${industry}` : "",
    langRule,
    `Rules: about ${words} words (enough to speak for ${seconds} seconds), short sentences, no hashtags, no emojis, no quotes, no stage directions.`,
    `Output only the words that will be spoken.`,
  ]
    .filter(Boolean)
    .join("\n");

  const hindiFallback = () => {
    const brand = company ? `${company}: ` : "";
    let text = `${brand}${topic}। यह आपके व्यवसाय को आगे बढ़ाने में मदद कर सकता है। सही फैसले से समय और पैसा दोनों बचते हैं। आज ही अगला कदम उठाएँ और अपने ग्राहकों से जुड़ें।`;
    if (seconds >= 30) {
      text += " सरल प्रक्रिया, भरोसेमंद सेवा और बेहतर नतीजे — यही असली फर्क लाते हैं।";
    }
    if (seconds >= 45) {
      text += " अभी शुरू करें और अपने दर्शकों तक यह बात पहुँचाएँ।";
    }
    return text;
  };

  const arabicFallback = () => {
    const brand = company ? `${company}: ` : "";
    let text = `${brand}${topic}. هذه الفكرة تساعد نشاطك على النمو وتوفير الوقت والمال. اتخذ الخطوة التالية اليوم وتواصل مع عملائك.`;
    if (seconds >= 30) {
      text += " عملية بسيطة، خدمة موثوقة، ونتائج أفضل — هذا هو الفرق الحقيقي.";
    }
    if (seconds >= 45) {
      text += " ابدأ الآن وأوصل رسالتك إلى جمهورك.";
    }
    return text;
  };

  try {
    const res = await axios.post(
      `${ollamaUrl()}/api/generate`,
      { model: process.env.OLLAMA_MODEL || "llama3", prompt, stream: false },
      { timeout: 30000 }
    );
    const text = String(res.data?.response || "")
      .replace(/^["'\s]+|["'\s]+$/g, "")
      .trim();
    if (text.split(/\s+/).length >= 8) {
      if (hindi && !looksLikeHindi(text)) {
        console.log("VIDEO SCRIPT was not Hindi — using Hindi fallback");
        return hindiFallback();
      }
      if (arabic && !looksLikeArabic(text)) {
        console.log("VIDEO SCRIPT was not Arabic — using Arabic fallback");
        return arabicFallback();
      }
      return text;
    }
  } catch (err) {
    console.log("VIDEO SCRIPT LLM ERROR:", err.message);
  }

  if (hindi) return hindiFallback();
  if (arabic) return arabicFallback();
  const brand = company ? `${company}: ` : "";
  return `${brand}${topic}. This idea can help you grow, stay visible, and connect with the right audience. Take the next step today.`;
};

const generateCaption = async ({ topic, company, industry, language, script }) => {
  const langLine =
    language === "hi"
      ? "Language: Hindi. Write the caption in Hindi Devanagari. Hashtags can be English."
      : language === "ar"
        ? "Language: Arabic. Write the caption in Arabic script. Hashtags can be English."
        : "Language: English.";
  const prompt = [
    `Write a short social media caption for a Reel/Short about: ${topic}`,
    company ? `Brand: ${company}` : "",
    industry ? `Industry: ${industry}` : "",
    `Spoken script (for context): ${script}`,
    langLine,
    `Rules: 2-3 lines, 3-6 relevant hashtags, no quotes around the whole caption.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await axios.post(
      `${ollamaUrl()}/api/generate`,
      { model: process.env.OLLAMA_MODEL || "llama3", prompt, stream: false },
      { timeout: 20000 }
    );
    const text = String(res.data?.response || "").trim();
    if (text.length > 20) return text;
  } catch (err) {
    console.log("VIDEO CAPTION LLM ERROR:", err.message);
  }

  return `🎬 ${topic}${company ? ` — ${company}` : ""}\n#Shorts #Reels #AI`;
};

const extractSearchTerms = (topic, script) => {
  const blob = `${topic} ${script}`.toLowerCase();
  const words = blob
    .replace(/[^a-zA-Z\u0900-\u097F\u0600-\u06FF\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const stop = new Set([
    "this", "that", "with", "from", "your", "about", "will", "have",
    "been", "they", "them", "their", "into", "just", "more", "than",
    "when", "what", "which", "while", "also", "only", "make", "made",
    "help", "take", "next", "step", "today", "idea", "grow", "stay",
  ]);
  const uniq = [];
  for (const w of words) {
    if (stop.has(w) || uniq.includes(w)) continue;
    uniq.push(w);
    if (uniq.length >= 5) break;
  }
  if (!uniq.length) uniq.push(topic.split(/\s+/)[0] || "business");
  return uniq;
};

const synthesizeVoice = async (script, voiceKey, audioPath) => {
  const cfg = VOICES[voiceKey] || VOICES["en-in"];
  const tts = new EdgeTTS({
    voice: cfg.voice,
    lang: cfg.lang,
    outputFormat: "audio-24khz-96kbitrate-mono-mp3",
    timeout: 60000,
  });
  console.log(`🎙️ Edge TTS voice=${cfg.voice}`);
  await tts.ttsPromise(script, audioPath);
  if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 1000) {
    throw new Error("Voiceover file was empty");
  }
  return audioPath;
};

const srtTime = (seconds) => {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.floor((clamped - Math.floor(clamped)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
};

const wrapCaption = (text, max = 42) => {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > max && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3).join("\n");
};

const writeSrt = (script, duration, srtPath) => {
  const sentences = String(script)
    .split(/(?<=[.!?।])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const parts = sentences.length ? sentences : [script];
  const totalChars = parts.reduce((n, p) => n + p.length, 0) || 1;
  let t = 0.15;
  const blocks = parts.map((text, i) => {
    const share = text.length / totalChars;
    const dur = Math.max(1.4, share * Math.max(duration - 0.3, 1));
    const start = t;
    const end = Math.min(duration, t + dur);
    t = end;
    return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${wrapCaption(text)}\n`;
  });
  fs.writeFileSync(srtPath, blocks.join("\n"), "utf8");
  return srtPath;
};

const generateSceneImage = async (prompt, seed, width, height) => {
  const encoded = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&nologo=true&seed=${seed}`;
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: Number(process.env.POLLINATIONS_TIMEOUT_MS || 120000),
    headers: { "User-Agent": "Mozilla/5.0" },
    validateStatus: (s) => s < 400,
  });
  if (!res.data || res.data.length < 1000) {
    throw new Error("Empty scene image");
  }
  return Buffer.from(res.data);
};

const fetchPexelsClips = async (terms, aspect, needed) => {
  const key = (process.env.PEXELS_API_KEY || "").trim();
  if (!key) return [];

  const orientation = aspect === "16:9" ? "landscape" : "portrait";
  const clips = [];

  for (const term of terms) {
    if (clips.length >= needed) break;
    try {
      const res = await axios.get("https://api.pexels.com/videos/search", {
        params: { query: term, per_page: 6, orientation },
        headers: { Authorization: key },
        timeout: 20000,
      });
      for (const video of res.data?.videos || []) {
        const files = (video.video_files || [])
          .filter((f) => String(f.file_type || "").includes("mp4"))
          .sort((a, b) => (b.height || 0) - (a.height || 0));
        const pick =
          files.find((f) => (f.height || 0) >= 720) || files[0];
        if (pick?.link && !clips.includes(pick.link)) {
          clips.push(pick.link);
        }
        if (clips.length >= needed) break;
      }
    } catch (err) {
      console.log(`Pexels search failed (${term}):`, err.message);
    }
  }

  console.log(`🎞️ Pexels clips: ${clips.length}`);
  return clips.slice(0, needed);
};

const downloadTo = async (url, dest) => {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 120000,
    headers: { "User-Agent": "Mozilla/5.0" },
    validateStatus: (s) => s < 400,
  });
  fs.writeFileSync(dest, Buffer.from(res.data));
  return dest;
};

const makeColorClip = async (outPath, duration, width, height) => {
  await runFfmpeg((cmd) => {
    cmd
      .input(`color=c=1a1a2e:s=${width}x${height}:d=${duration.toFixed(3)}`)
      .inputOptions(["-f", "lavfi"])
      .outputOptions([
        "-t",
        duration.toFixed(3),
        "-r",
        "24",
        ...H264_COMPAT,
        "-an",
      ])
      .output(outPath);
  });
};

const makeStillClip = async (imagePath, outPath, duration, width, height) => {
  const fadeOutStart = Math.max(0.2, duration - 0.35);
  await runFfmpeg((cmd) => {
    cmd
      .input(imagePath)
      .inputOptions(["-loop", "1"])
      .outputOptions([
        "-t",
        duration.toFixed(3),
        "-vf",
        `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=24,fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.3`,
        ...H264_COMPAT,
        "-an",
      ])
      .output(outPath);
  });
};

const makeVideoClip = async (srcPath, outPath, duration, width, height) => {
  const fadeOutStart = Math.max(0.2, duration - 0.35);
  await runFfmpeg((cmd) => {
    cmd
      .input(srcPath)
      .inputOptions(["-ss", "0.4"])
      .outputOptions([
        "-t",
        duration.toFixed(3),
        "-vf",
        `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=24,fade=t=in:st=0:d=0.25,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.25`,
        ...H264_COMPAT,
        "-an",
      ])
      .output(outPath);
  });
};

const concatClips = async (clipPaths, listPath, outPath) => {
  const list = clipPaths
    .map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(listPath, list, "utf8");
  try {
    await runFfmpeg((cmd) => {
      cmd
        .input(listPath)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .outputOptions(["-c", "copy"])
        .output(outPath);
    });
  } catch (err) {
    console.log("Concat copy failed, re-encoding:", err.message);
    await runFfmpeg((cmd) => {
      cmd
        .input(listPath)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .outputOptions([
          ...H264_COMPAT,
          "-an",
        ])
        .output(outPath);
    });
  }
};

const muxAudio = async (videoPath, audioPath, outPath, durationSec) => {
  await runFfmpeg((cmd) => {
    cmd
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-t",
        durationSec.toFixed(3),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-movflags",
        "+faststart",
      ])
      .output(outPath);
  });
};

const parseDurationSeconds = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 15;
  return Math.min(60, Math.max(10, Math.round(n)));
};

const fitVoiceover = async (srcPath, destPath, targetSec) => {
  const actual = await probeDuration(srcPath);
  if (!actual || actual < 0.4) {
    fs.copyFileSync(srcPath, destPath);
    return destPath;
  }

  // Bundled ffmpeg (2018) has no apad pad_dur — pad indefinitely and stop with -t
  if (actual <= targetSec + 0.15) {
    if (targetSec - actual < 0.05) {
      fs.copyFileSync(srcPath, destPath);
      return destPath;
    }
    await runFfmpeg((cmd) => {
      cmd
        .input(srcPath)
        .audioFilters("apad")
        .outputOptions([
          "-t",
          targetSec.toFixed(3),
          "-c:a",
          "libmp3lame",
          "-q:a",
          "4",
        ])
        .output(destPath);
    });
    return destPath;
  }

  const tempo = Math.min(1.4, Math.max(0.5, actual / targetSec));
  await runFfmpeg((cmd) => {
    cmd
      .input(srcPath)
      .audioFilters(`atempo=${tempo.toFixed(3)}`)
      .outputOptions([
        "-t",
        targetSec.toFixed(3),
        "-c:a",
        "libmp3lame",
        "-q:a",
        "4",
      ])
      .output(destPath);
  });
  return destPath;
};

const burnSubtitles = async (videoPath, srtPath, outPath) => {
  const escaped = escapeSubtitlesPath(srtPath);
  await runFfmpeg((cmd) => {
    cmd
      .input(videoPath)
      .outputOptions([
        "-vf",
        `subtitles='${escaped}':force_style='FontName=Arial,Fontsize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=60'`,
        "-c:a",
        "copy",
        ...H264_COMPAT,
      ])
      .output(outPath);
  });
};

const buildLocalVideo = async (data, workDir) => {
  const topic = String(data.topic || data.videoSubject || "").trim();
  const language = resolveNarrationLanguage(data.language, data.voice);
  const aspect = data.aspect === "16:9" ? "16:9" : "9:16";
  const voiceKey =
    data.voice && VOICES[data.voice]
      ? data.voice
      : defaultVoiceForLanguage(language);
  const { width, height } = sizeForAspect(aspect);
  const targetSec = parseDurationSeconds(
    data.duration || data.durationSec || data.videoDuration
  );
  const report = (progress, stage, label) => {
    try {
      data.onProgress?.(progress, stage, label);
    } catch {}
  };

  report(6, "script", `Writing ${targetSec}s script…`);
  console.log(`📝 Generating narration script (${targetSec}s)…`);
  const script = await generateScript({
    topic,
    company: data.company,
    industry: data.industry,
    language,
    customScript: data.script || data.videoScript,
    durationSec: targetSec,
  });

  const rawAudioPath = path.join(workDir, "voice-raw.mp3");
  const audioPath = path.join(workDir, "voice.mp3");
  report(18, "voice", "Generating voiceover…");
  await synthesizeVoice(script, voiceKey, rawAudioPath);
  report(28, "voice", "Fitting voice to duration…");
  console.log("🔊 Fitting voiceover to duration…");
  await fitVoiceover(rawAudioPath, audioPath, targetSec);
  const duration = targetSec;
  console.log(`🔊 Target duration: ${duration}s`);

  const clipCount = Math.min(6, Math.max(3, Math.round(duration / 8)));
  const clipDuration = duration / clipCount;
  const terms = extractSearchTerms(topic, script);

  const clipPaths = [];
  const pexels = await fetchPexelsClips(terms, aspect, clipCount);
  report(32, "footage", "Collecting footage…");

  for (let i = 0; i < clipCount; i++) {
    const clipPct = 32 + Math.round(((i + 1) / clipCount) * 40);
    report(clipPct, "footage", `Building scene ${i + 1} of ${clipCount}…`);
    const clipPath = path.join(workDir, `clip_${i}.mp4`);
    try {
      if (pexels[i]) {
        const raw = path.join(workDir, `raw_${i}.mp4`);
        await downloadTo(pexels[i], raw);
        await makeVideoClip(raw, clipPath, clipDuration, width, height);
      } else {
        throw new Error("no pexels clip");
      }
    } catch (err) {
      console.log(`Scene ${i + 1} stock clip skipped:`, err.message);
      const scenePrompt = [
        `cinematic ${aspect === "9:16" ? "vertical" : "widescreen"} footage`,
        terms[i % terms.length] || topic,
        data.industry || "",
        "photorealistic, no text, no watermark, no logo, no letters",
      ]
        .filter(Boolean)
        .join(", ");
      const imgPath = path.join(workDir, `scene_${i}.jpg`);
      try {
        const buf = await generateSceneImage(
          scenePrompt,
          Date.now() + i,
          width,
          height
        );
        fs.writeFileSync(imgPath, buf);
        await makeStillClip(imgPath, clipPath, clipDuration, width, height);
      } catch (imgErr) {
        console.log("Scene image failed, using color clip:", imgErr.message);
        await makeColorClip(clipPath, clipDuration, width, height);
      }
    }
    clipPaths.push(clipPath);
    await sleep(200);
  }

  const concatPath = path.join(workDir, "concat.mp4");
  const listPath = path.join(workDir, "concat.txt");
  console.log("🧩 Concatenating clips…");
  report(76, "render", "Stitching clips…");
  await concatClips(clipPaths, listPath, concatPath);

  const voicedPath = path.join(workDir, "voiced.mp4");
  console.log("🎧 Mixing voiceover…");
  report(84, "render", "Mixing voiceover…");
  await muxAudio(concatPath, audioPath, voicedPath, duration);

  const srtPath = path.join(workDir, "subs.srt");
  writeSrt(script, duration, srtPath);

  const finalPath = path.join(workDir, "final.mp4");
  console.log("💬 Burning subtitles…");
  report(92, "render", "Adding subtitles…");
  try {
    await burnSubtitles(voicedPath, srtPath, finalPath);
  } catch (err) {
    console.log("Subtitle burn failed, using voiced video:", err.message);
    fs.copyFileSync(voicedPath, finalPath);
  }

  return { script, videoPath: finalPath };
};

/**
 * MoneyPrinterTurbo-style short: topic → script → TTS → footage → subtitles → mp4.
 * Uses a live MoneyPrinterTurbo API when MPT_API_URL is set; otherwise local FFmpeg pipeline.
 */
export const generateShortVideo = async (data) => {
  const topic = String(data.topic || data.videoSubject || "").trim();
  if (!topic) throw new Error("Video topic is required");

  const report = (progress, stage, label) => {
    try {
      data.onProgress?.(progress, stage, label);
    } catch {}
  };

  const stamp = `${Date.now()}`;
  const workDir = path.join(getUploadsRoot(), "videos", stamp);
  fs.mkdirSync(workDir, { recursive: true });

  let videoPath;
  let script = String(data.script || data.videoScript || "").trim();

  report(4, "script", "Starting video pipeline…");

  if (isMptConfigured()) {
    try {
      report(20, "render", "MoneyPrinterTurbo generating…");
      videoPath = await generateWithMoneyPrinter({
        topic,
        script,
        language: resolveNarrationLanguage(data.language, data.voice),
        aspect: data.aspect === "16:9" ? "16:9" : "9:16",
        voice: mptVoiceFor(
          resolveNarrationLanguage(data.language, data.voice),
          data.voice
        ),
        durationSec: parseDurationSeconds(
          data.duration || data.durationSec || data.videoDuration
        ),
        outDir: workDir,
      });
      if (!script) script = topic;
    } catch (err) {
      console.log("MoneyPrinterTurbo API failed, using local pipeline:", err.message);
      const local = await buildLocalVideo(data, workDir);
      videoPath = local.videoPath;
      script = local.script;
    }
  } else {
    const local = await buildLocalVideo(data, workDir);
    videoPath = local.videoPath;
    script = local.script;
  }

  report(96, "finish", "Writing caption…");
  const language = resolveNarrationLanguage(data.language, data.voice);
  const rawCaption = await generateCaption({
    topic,
    company: data.company,
    industry: data.industry,
    language,
    script,
  });
  const text = appendCtaToCaption(rawCaption, data);
  const cta = buildCtaLinks(data);
  report(100, "finish", "Video ready");

  return {
    text,
    script,
    video: videoPath,
    videos: [videoPath],
    images: [],
    cta,
  };
};
