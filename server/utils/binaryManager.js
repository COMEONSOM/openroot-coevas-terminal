// utils/binaryManager.js
import { existsSync, copyFileSync, mkdirSync } from "fs";
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
  // 1. Already copied to safe AppData location
  const safePath = path.join(BIN_DIR, name);
  if (existsSync(safePath)) {
    console.log(`[BinManager] Using cached: ${safePath}`);
    return safePath;
  }

  // 2. Packaged app — resources/server/
  if (process.resourcesPath) {
    const resourcePath = path.join(process.resourcesPath, "server", name);
    if (existsSync(resourcePath)) {
      try {
        ensureBinDir();
        copyFileSync(resourcePath, safePath);
        console.log(`[BinManager] Copied from resources: ${safePath}`);
        return safePath;
      } catch (e) {
        console.warn(`[BinManager] Copy failed, using direct: ${e.message}`);
        return resourcePath;
      }
    }
  }

  // 3. Dev mode — server/ folder (next to this file's parent)
  const devPath = path.join(__dirname, "../", name);
  if (existsSync(devPath)) {
    try {
      ensureBinDir();
      copyFileSync(devPath, safePath);
      console.log(`[BinManager] Copied from server/: ${safePath}`);
      return safePath;
    } catch (e) {
      console.warn(`[BinManager] Dev copy failed, using direct: ${e.message}`);
      return devPath;
    }
  }

  // 4. System PATH fallback
  console.warn(`[BinManager] ${name} not found in server/ — using system PATH`);
  return name;
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