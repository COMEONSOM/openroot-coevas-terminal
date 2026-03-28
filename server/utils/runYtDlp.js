// utils/runYtDlp.js
import { spawn }                from "child_process";
import { existsSync, mkdirSync } from "fs";
import path                     from "path";
import os                       from "os";
import { fileURLToPath }        from "url";
import { YTDLP_BIN, FFMPEG_BIN } from "./binaryManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* ======================================================
   COOKIES
   Only uses cookies if the user explicitly placed a valid
   cookies_youtube.txt at ~/.coevas/cookies_youtube.txt
   Never auto-copies from source — stale dev cookies break
   YouTube requests by triggering auth rejection (null JSON)
====================================================== */
const YT_COOKIES_PROD = path.join(os.homedir(), ".coevas", "cookies_youtube.txt");

function getCookieArgs() {
  if (existsSync(YT_COOKIES_PROD)) {
    console.log("[Cookies] Using:", YT_COOKIES_PROD);
    return ["--cookies", YT_COOKIES_PROD];
  }
  console.log("[Cookies] No cookies file — proceeding without");
  return [];
}

/* ======================================================
   BASE ARGS — used for all downloads
====================================================== */
const BASE = [
  "--no-config",
  "--no-playlist",
  "--no-warnings",
  "--no-check-certificates",
  "--no-check-formats",
  "--socket-timeout",       "30",
  "--extractor-retries",    "5",
  "--retry-sleep",          "linear=1::3",
  "--retries",              "3",
  "--fragment-retries",     "5",
  "--concurrent-fragments", "3",
];

/* ======================================================
   BASE PROBE ARGS — minimal, for -J info extraction only
====================================================== */
const BASE_PROBE = [
  "--no-config",
  "--no-playlist",
  "--no-warnings",
  "--no-check-certificates",
  "--no-check-formats",
  "--ignore-errors",
  "--socket-timeout", "30",
];

const STRIP = new Set([
  "--no-config",
  "--no-playlist",
  "--no-warnings",
  "--no-check-formats",
  "--ignore-errors",
  "--extractor-retries",
  "--retry-sleep",
  "--retries",
  "--fragment-retries",
  "--concurrent-fragments",
]);

/* ======================================================
   SPAWN ENV
====================================================== */
const SPAWN_ENV = { ...process.env, PYTHONUTF8: "1" };

/* ======================================================
   STARTUP CHECK
====================================================== */
const check = spawn(YTDLP_BIN, ["--version"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: SPAWN_ENV
});
check.stdout.on("data", d => console.log("[yt-dlp]", d.toString().trim()));
check.stderr.on("data", d => console.warn("[yt-dlp WARN]", d.toString().trim()));
check.on("error", e  => console.error("[yt-dlp ERROR] Binary not found:", e.message));

/* ======================================================
   CORE DOWNLOAD SPAWNER
====================================================== */
export function spawnYtDlp(client = "tv_embedded", userArgs = [], opts = {}) {
  const args = [
    ...BASE,
    "--extractor-args", `youtube:player_client=${client}`,
    ...getCookieArgs(),
    "--ffmpeg-location", FFMPEG_BIN,
    ...userArgs.filter(a => !STRIP.has(a)),
  ];

  console.log(`[yt-dlp] client=${client} | bin=${YTDLP_BIN}`);
  return spawn(YTDLP_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env:   SPAWN_ENV,
    ...opts,
  });
}

/* ======================================================
   INFO PROBE SPAWNER — with cookies
====================================================== */
export function spawnYtDlpProbe(client = "tv_embedded", userArgs = [], opts = {}) {
  const args = [
    ...BASE_PROBE,
    "--extractor-args", `youtube:player_client=${client}`,
    ...getCookieArgs(),
    ...userArgs,
  ];

  console.log(`[yt-dlp probe] client=${client}`);
  return spawn(YTDLP_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env:   SPAWN_ENV,
    ...opts,
  });
}

/* ======================================================
   INFO PROBE SPAWNER — no cookies
   Fallback when cookie-based probe returns null JSON
====================================================== */
export function spawnYtDlpProbeNoCookies(client = "tv_embedded", userArgs = [], opts = {}) {
  const args = [
    ...BASE_PROBE,
    "--extractor-args", `youtube:player_client=${client}`,
    ...userArgs,
  ];

  console.log(`[yt-dlp probe/no-cookies] client=${client}`);
  return spawn(YTDLP_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env:   SPAWN_ENV,
    ...opts,
  });
}

/* ======================================================
   BACKWARD COMPATIBILITY
====================================================== */
export function startYtDlpInfo(userArgs = [], opts = {}) {
  return spawnYtDlpProbe("tv_embedded", userArgs, opts);
}

export function startYtDlp(userArgs = [], opts = {}) {
  return spawnYtDlp("tv_embedded", userArgs, opts);
}

export { getCookieArgs, BASE, STRIP, SPAWN_ENV, FFMPEG_BIN };