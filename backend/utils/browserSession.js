import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

export const markProfileCleanExit = (sessionDir) => {
  const prefsPath = path.join(sessionDir, "Default", "Preferences");
  try {
    if (!fs.existsSync(prefsPath)) return;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
    prefs.profile = prefs.profile || {};
    prefs.profile.exit_type = "Normal";
    prefs.profile.exited_cleanly = true;
    prefs.session = prefs.session || {};
    prefs.session.restore_on_startup = 5;
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch (err) {
    console.log("Profile cleanup skipped:", err.message);
  }
};

export const killBrowsersUsingProfile = (sessionDir) => {
  if (process.platform !== "win32" || !sessionDir) return;
  const needle = String(sessionDir).replace(/'/g, "''");
  const script = `
    Get-CimInstance Win32_Process |
      Where-Object {
        $_.CommandLine -and
        $_.CommandLine -like '*${needle}*' -and
        ($_.Name -match 'chrome|msedge|chromium')
      } |
      ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      }
  `;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      timeout: 20000,
      stdio: "ignore",
    });
  } catch {}
};

export const clearProfileLock = (sessionDir) => {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      fs.unlinkSync(path.join(sessionDir, name));
    } catch {}
  }
};

export const prepareBrowserProfile = (sessionDir) => {
  killBrowsersUsingProfile(sessionDir);
  clearProfileLock(sessionDir);
  markProfileCleanExit(sessionDir);
};

export const closeExtraPages = async (browser, keepPage) => {
  try {
    const pages = await browser.pages();
    for (const extra of pages) {
      if (keepPage && extra === keepPage) continue;
      try {
        await extra.close();
      } catch {}
    }
  } catch {}
};

export const useSinglePage = async (browser) => {
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  for (const extra of pages) {
    if (extra === page) continue;
    try {
      await extra.close();
    } catch {}
  }
  return page;
};

export const closeBrowserHard = async (browser, sessionDir) => {
  if (browser) {
    try {
      const pages = await browser.pages();
      for (const p of pages) {
        try {
          await p.close();
        } catch {}
      }
    } catch {}
    try {
      await browser.close();
    } catch {}
  }
  killBrowsersUsingProfile(sessionDir);
  await delay(1500);
};
