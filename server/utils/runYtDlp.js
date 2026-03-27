// utils/runYtDlp.js
import { spawn }      from "child_process";
import { existsSync } from "fs";
import path           from "path";
import os             from "os";
import { fileURLToPath } from "url";
import { YTDLP_BIN, FFMPEG_BIN } from "./binaryManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* ======================================================
   COOKIES
====================================================== */
const YT_COOKIES_DEV  = path.join(__dirname, "../cookies_youtube.txt");
const YT_COOKIES_PROD = path.join(os.homedir(), ".coevas", "cookies_youtube.txt");

function getCookieArgs() {
  const cookiePath = existsSync(YT_COOKIES_PROD)
    ? YT_COOKIES_PROD
    : existsSync(YT_COOKIES_DEV)
    ? YT_COOKIES_DEV
    : null;

  if (cookiePath) {
    console.log("Cookies:", cookiePath);
    return ["--cookies", cookiePath];
  }
  return [];
}

/* ======================================================
   BASE ARGS
====================================================== */
const BASE = [
  "--no-config",
  "--no-playlist",
  "--no-warnings",
  "--no-check-certificates",
  "--socket-timeout", "30",
];

const STRIP = new Set(["--no-config", "--no-playlist", "--no-warnings"]);

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
   CORE SPAWNER — used by strategy engine
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
   INFO — ONLY tv_embedded (single client = clean probe)
   Multi-client merges ios muxed 360p into format list
   → corrupts maxHeight detection in server.js
====================================================== */
export function startYtDlpInfo(userArgs = [], opts = {}) {
  return spawnYtDlp("tv_embedded", [
    "--extractor-retries", "3",
    "--retry-sleep",       "linear=1::2",
    ...userArgs,
  ], opts);
}

/* ======================================================
   DOWNLOAD — tv_embedded default
   Multi-client rotation is handled by youtube.js strategy engine
   which calls spawnYtDlp(client, ...) directly per attempt
====================================================== */
export function startYtDlp(userArgs = [], opts = {}) {
  return spawnYtDlp("tv_embedded", [
    "--extractor-retries", "5",
    "--retry-sleep",       "linear=1::3",
    "--retries",           "3",
    "--fragment-retries",  "3",
    "--concurrent-fragments", "3",
    ...userArgs,
  ], opts);
}

export { getCookieArgs, BASE, STRIP, SPAWN_ENV, FFMPEG_BIN };