import fs from "fs";
import path from "path";

/**
 * Resolve browser launch options for Instagram.
 * Prefer Edge via executablePath (channel: "msedge" crashes on some Windows/Puppeteer setups).
 */
export const resolveIgBrowserLaunch = () => {
  const preferred = String(process.env.IG_BROWSER_CHANNEL || "msedge")
    .trim()
    .toLowerCase();

  if (preferred === "chrome" || preferred === "chromium") {
    return { label: "bundled Chromium", options: {} };
  }

  const fromEnv = process.env.IG_BROWSER_PATH?.trim();
  const candidates = [
    fromEnv,
    process.env["ProgramFiles(x86)"] &&
      path.join(
        process.env["ProgramFiles(x86)"],
        "Microsoft",
        "Edge",
        "Application",
        "msedge.exe"
      ),
    process.env.ProgramFiles &&
      path.join(
        process.env.ProgramFiles,
        "Microsoft",
        "Edge",
        "Application",
        "msedge.exe"
      ),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return {
        label: `Edge (${candidate})`,
        options: { executablePath: candidate },
      };
    }
  }

  throw new Error(
    "Microsoft Edge not found. Install Edge on the server, or set IG_BROWSER_PATH to msedge.exe, or IG_BROWSER_CHANNEL=chrome."
  );
};
