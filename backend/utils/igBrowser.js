import fs from "fs";
import path from "path";

const EDGE_CANDIDATES = () => {
  const fromEnv = process.env.IG_BROWSER_PATH?.trim();
  return [
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
};

/**
 * Resolve browser launch options for Instagram.
 * Always uses Edge via executablePath (never bundled Chrome/Chromium).
 */
export const resolveIgBrowserLaunch = () => {
  const preferred = String(process.env.IG_BROWSER_CHANNEL || "msedge")
    .trim()
    .toLowerCase();

  if (preferred === "chrome" || preferred === "chromium") {
    console.warn(
      "WARNING: IG_BROWSER_CHANNEL is chrome/chromium — Instagram will use bundled Chrome."
    );
    return { label: "bundled Chromium (Chrome)", options: {} };
  }

  for (const candidate of EDGE_CANDIDATES()) {
    if (fs.existsSync(candidate)) {
      return {
        label: `Microsoft Edge`,
        executablePath: candidate,
        options: { executablePath: candidate },
      };
    }
  }

  throw new Error(
    "Microsoft Edge not found. Install Edge, or set IG_BROWSER_PATH to full msedge.exe path. Do NOT use Chrome for Instagram."
  );
};

/** After launch, confirm the OS process is Edge — not Chrome/Chromium. */
export const assertEdgeProcess = (browser) => {
  const proc = browser.process?.();
  const spawnfile = String(proc?.spawnfile || "");
  const args0 = String(proc?.spawnargs?.[0] || "");
  const combined = `${spawnfile} ${args0}`.toLowerCase();

  console.log("Instagram browser process:", spawnfile || args0 || "(unknown)");

  if (!combined.includes("msedge")) {
    throw new Error(
      `Expected Microsoft Edge (msedge.exe) but got: ${spawnfile || args0 || "unknown"}. Deploy latest code and ensure Edge is installed.`
    );
  }
};
