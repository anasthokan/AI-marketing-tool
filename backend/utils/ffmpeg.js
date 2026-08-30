import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

export const getFfmpegPath = () => ffmpegInstaller.path;
export const getFfprobePath = () => ffprobeInstaller.path;

export const runFfmpeg = (configure) =>
  new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    configure(cmd);
    cmd
      .on("end", () => resolve())
      .on("error", (err, stdout, stderr) => {
        const detail = String(stderr || err.message || "").trim();
        const short = detail.split("\n").slice(-8).join("\n");
        reject(new Error(short || err.message));
      })
      .run();
  });

export const probeDuration = (file) =>
  new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) return reject(err);
      resolve(Number(data?.format?.duration) || 0);
    });
  });

/** Windows-safe path for ffmpeg subtitles= filter */
export const escapeSubtitlesPath = (filepath) =>
  String(filepath)
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:");
