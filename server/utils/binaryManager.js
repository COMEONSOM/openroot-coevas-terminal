// utils/binaryManager.js
import { existsSync, copyFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import os   from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const BIN_DIR = path.join(os.homedir(), ".coevas", "bin");

function ensureBinDir() {
  if (!existsSync(BIN_DIR)) mkdirSync(BIN_DIR, { recursive: true });
}

function resolveBinary(name) {
  const safePath = path.join(BIN_DIR, name);
  let bundledPath = null;

  // Packaged app — resources/server/.
  if (process.resourcesPath) {
    const resourcePath = path.join(process.resourcesPath, "server", name);
    if (existsSync(resourcePath)) bundledPath = resourcePath;
  }

  // Dev mode — server/ folder (next to this file's parent).
  const devPath = path.join(__dirname, "../", name);
  if (!bundledPath && existsSync(devPath)) bundledPath = devPath;

  // Refresh a cached yt-dlp only when the bundled executable is newer. This
  // keeps Electron on the managed binary while allowing packaged upgrades to
  // replace stale copies in ~/.coevas/bin.
  if (name === "yt-dlp.exe" && existsSync(safePath) && bundledPath) {
    try {
      const bundledVersion = readVersion(bundledPath);
      let cachedVersion = null;
      try { cachedVersion = readVersion(safePath); } catch {}
      if (!cachedVersion || compareVersions(bundledVersion, cachedVersion) > 0) {
        copyFileSync(bundledPath, safePath);
        console.log(`[BinManager] Updated yt-dlp cache ${cachedVersion || "unreadable"} → ${bundledVersion}`);
      }
      return safePath;
    } catch (e) {
      console.warn(`[BinManager] Could not refresh yt-dlp cache: ${e.message}`);
      return bundledPath;
    }
  }

  if (existsSync(safePath)) {
    console.log(`[BinManager] Using cached: ${safePath}`);
    return safePath;
  }

  if (bundledPath) {
    try {
      ensureBinDir();
      copyFileSync(bundledPath, safePath);
      console.log(`[BinManager] Copied bundled binary: ${safePath}`);
      return safePath;
    } catch (e) {
      console.warn(`[BinManager] Copy failed, using bundled binary: ${e.message}`);
      return bundledPath;
    }
  }

  // System PATH fallback.
  console.warn(`[BinManager] ${name} not found in server/ — using system PATH`);
  return name;
}

function readVersion(binaryPath) {
  return execFileSync(binaryPath, ["--version"], { timeout: 10000, encoding: "utf8" }).trim();
}

function compareVersions(left, right) {
  const a = String(left).match(/\d+/g)?.map(Number) || [];
  const b = String(right).match(/\d+/g)?.map(Number) || [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export const YTDLP_BIN  = resolveBinary("yt-dlp.exe");
export const FFMPEG_BIN = resolveBinary("ffmpeg.exe");

if (!existsSync(FFMPEG_BIN)) {
  console.error("[BinManager] ffmpeg not found anywhere — audio merge WILL fail!");
} else {
  console.log(`[BinManager] ffmpeg ready: ${FFMPEG_BIN}`);
}

if (!existsSync(YTDLP_BIN)) {
  console.error("[BinManager] yt-dlp not found anywhere!");
} else {
  console.log(`[BinManager] yt-dlp ready: ${YTDLP_BIN}`);
}
