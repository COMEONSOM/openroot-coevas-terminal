// youtube.js — Never-Fail Adaptive Media Extraction Engine
import path from "path";
import os   from "os";
import fs   from "fs";
import { spawnYtDlp } from "./utils/runYtDlp.js";
import { sendLog }     from "./utils/logStream.js";



/* ======================================================
   STRATEGY CONSTANTS
====================================================== */
const CLIENTS     = ["tv_embedded", "web", "ios", "android"];
const RESOLUTIONS = [4320, 2160, 1440, 1080, 720, 480, 360, 0];


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FIX #1 — buildFormatTiers now accepts allowAV1
//
// When allowAV1 = false → every video filter gets
// [vcodec!^=av01] so yt-dlp CANNOT pick AV1 even if it
// is the only format available at that resolution.
//
// When allowAV1 = true → no codec filter, yt-dlp picks
// freely (AV1 > VP9 > H.264 by bitrate efficiency).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function buildFormatTiers(height, allowAV1 = true) {
  const noAV1 = allowAV1 ? "" : "[vcodec!^=av01]";

  if (!height) return [
    `bv*${noAV1}+ba`,
    `bv*${noAV1}+ba/b${noAV1}`,
    `b${noAV1}`,
  ];

  return [
    `bv*${noAV1}[height<=${height}]+ba`,
    `b${noAV1}[height<=${height}]`,
    `bv*${noAV1}+ba`,
    `b${noAV1}`,
  ];
}



/* ======================================================
   ERROR CLASSIFIER
====================================================== */
function classifyError(stderr = "", code) {
  if (stderr.includes("Requested format is not available")) return "FORMAT_UNAVAILABLE";
  if (stderr.includes("Sign in to confirm") ||
      stderr.includes("age-restricted"))                    return "AUTH_REQUIRED";
  if (stderr.includes("Private video") ||
      stderr.includes("removed"))                           return "VIDEO_UNAVAILABLE";
  if (stderr.includes("HTTP Error 429") ||
      stderr.includes("Too Many Requests"))                 return "RATE_LIMITED";
  if (stderr.includes("Unable to extract") ||
      stderr.includes("extraction"))                        return "EXTRACTION_FAILED";
  if (code === 1)                                           return "GENERIC_FAILURE";
  return "UNKNOWN";
}



/* ======================================================
   FILE UTILITIES
====================================================== */
function collectOutputFiles(tmpDir) {
  try {
    return fs.readdirSync(tmpDir)
      .filter(f => !f.endsWith(".part") && !f.endsWith(".ytdl"))
      .map(f => path.join(tmpDir, f))
      .filter(f => fs.statSync(f).isFile())
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  } catch {
    return [];
  }
}

function pickBestFile(files, isAudio) {
  if (isAudio) {
    return files.find(f => f.endsWith(".mp3")) ||
           files.find(f => f.endsWith(".m4a")) ||
           files[0] || null;
  }
  return files.find(f => f.endsWith(".mp4"))  ||
         files.find(f => f.endsWith(".webm")) ||
         files[0] || null;
}

function isValidFile(file) {
  try {
    return !!file && fs.existsSync(file) && fs.statSync(file).size > 1024;
  } catch {
    return false;
  }
}



/* ======================================================
   CORE SPAWNER
====================================================== */
function spawnAttempt({ client, formatStr, extraArgs, url, tmpDir, app, isAudio }) {
  return new Promise((resolve, reject) => {
    const outTmpl = isAudio
      ? path.join(tmpDir, "%(title).80s [%(id)s].%(ext)s")
      : path.join(tmpDir, "%(title).80s [%(resolution)s] [%(id)s].%(ext)s");

    const args = [
      "--newline", "--progress",
      "--no-playlist", "--no-config",
      "-f", formatStr,
      "--merge-output-format", "mp4",
      "-o", outTmpl,
      ...extraArgs,
      url
    ];

    let stderr  = "";
    let settled = false;

    const proc = spawnYtDlp(client, args);
    if (!proc) return reject({ type: "SPAWN_FAILED", message: "Failed to spawn yt-dlp" });

    app.locals.currentProc = proc;

    proc.stdout.on("data", chunk => {
      chunk.toString().split("\n").filter(Boolean).forEach(line => {
        sendLog(app, line);
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) {
          const pr = app.locals.progressRes;
          if (pr && !pr.writableEnded) {
            pr.write(`data: ${parseFloat(m[1])}\n\n`);
            if (typeof pr.flush === "function") pr.flush();
          }
        }
      });
    });

    proc.stderr.on("data", chunk => {
      chunk.toString().split("\n").filter(Boolean).forEach(line => {
        if (
          line.includes("frame=")     || line.includes("fps=")   ||
          line.includes("time=")      || line.includes("bitrate=") ||
          line.includes("speed=")     || line.includes("Deno")   ||
          line.includes("nsig")       || line.includes("EJS")    ||
          line.includes("Extracting") || line.includes("JS player")
        ) return;
        stderr += line + "\n";
        sendLog(app, `⚠ ${line}`);
      });
    });

    proc.on("error", err => reject({ type: "SPAWN_FAILED", message: err.message }));

    proc.on("close", code => {
      if (settled) return;
      settled = true;
      app.locals.currentProc = null;

      if (app.locals.cancelRequested) return reject({ type: "CANCELLED" });

      const file = pickBestFile(collectOutputFiles(tmpDir), isAudio);
      if (isValidFile(file)) return resolve(file);

      reject({ type: classifyError(stderr, code), message: stderr.slice(0, 300), code });
    });
  });
}



/* ======================================================
   VIDEO STRATEGY ENGINE
   FIX #2 — allowAV1 accepted and passed to buildFormatTiers
====================================================== */
async function runVideoStrategies({ url, targetHeight, allowAV1, tmpDir, app }) {
  for (const client of CLIENTS) {
    if (app.locals.cancelRequested) return null;

    const resLadder = targetHeight
      ? RESOLUTIONS.filter(r => r === 0 || r <= targetHeight)
      : [0];

    for (const height of resLadder) {
      if (app.locals.cancelRequested) return null;

      const label = height ? `${height}p` : "Best";
      // ↓ allowAV1 now flows into every format string
      const tiers = buildFormatTiers(height, allowAV1);

      for (const formatStr of tiers) {
        if (app.locals.cancelRequested) return null;

        sendLog(app, `Trying [${client}] ${label} | -f "${formatStr}"`);

        try {
          const file = await spawnAttempt({
            client, formatStr,
            extraArgs: [],
            url, tmpDir, app, isAudio: false
          });

          if (isValidFile(file)) {
            sendLog(app, `Success: [${client}] ${label} | -f "${formatStr}"`);
            return file;
          }
        } catch (err) {
          if (err.type === "CANCELLED")         return null;
          if (err.type === "VIDEO_UNAVAILABLE") return "VIDEO_UNAVAILABLE";
          if (err.type === "AUTH_REQUIRED") {
            sendLog(app, "Login required — add cookies_youtube.txt to ~/.coevas/");
          }
          if (err.type === "RATE_LIMITED") {
            sendLog(app, "Rate limited — waiting 3s...");
            await sleep(3000);
          }
          sendLog(app, `↩ [${client}] ${label} "${formatStr}" → ${err.type}`);
        }
      }
      sendLog(app, `↓ [${client}] All tiers failed at ${label} — stepping down`);
    }
    sendLog(app, `⟶ [${client}] exhausted — trying next client`);
  }

  return null;
}



/* ======================================================
   AUDIO STRATEGY ENGINE (unchanged)
====================================================== */
async function runAudioStrategies({ url, tmpDir, app }) {
  const audioFormats = ["ba", "ba/b", "b"];

  for (const client of CLIENTS) {
    if (app.locals.cancelRequested) return null;

    for (const formatStr of audioFormats) {
      if (app.locals.cancelRequested) return null;

      sendLog(app, `Trying audio [${client}] | -f "${formatStr}"`);

      try {
        const file = await spawnAttempt({
          client, formatStr,
          extraArgs: ["-x", "--audio-format", "mp3", "--audio-quality", "0"],
          url, tmpDir, app, isAudio: true
        });

        if (isValidFile(file)) {
          sendLog(app, `Audio success: [${client}] -f "${formatStr}"`);
          return file;
        }
      } catch (err) {
        if (err.type === "CANCELLED")         return null;
        if (err.type === "VIDEO_UNAVAILABLE") return "VIDEO_UNAVAILABLE";
        if (err.type === "RATE_LIMITED") {
          sendLog(app, "Rate limited — waiting 3s...");
          await sleep(3000);
        }
        sendLog(app, `↩ Audio [${client}] "${formatStr}" → ${err.type}`);
      }
    }
    sendLog(app, `⟶ Audio [${client}] exhausted — trying next client`);
  }

  return null;
}



/* ======================================================
   NUCLEAR FALLBACK
   Note: nuclear never uses AV1 filter — it's last resort
   and we just want SOMETHING to succeed.
====================================================== */
async function runNuclearFallback({ url, tmpDir, app }) {
  sendLog(app, "☢ Nuclear fallback — simplest possible args, web client");

  const nuclearFormats = ["b", "bv*+ba", "worst"];

  for (const formatStr of nuclearFormats) {
    if (app.locals.cancelRequested) return null;

    try {
      const file = await spawnAttempt({
        client: "web", formatStr,
        extraArgs: [],
        url, tmpDir, app, isAudio: false
      });

      if (isValidFile(file)) {
        sendLog(app, `Nuclear fallback succeeded with -f "${formatStr}"`);
        return file;
      }
    } catch (err) {
      if (err.type === "CANCELLED")         return null;
      if (err.type === "VIDEO_UNAVAILABLE") return "VIDEO_UNAVAILABLE";
      sendLog(app, `☢ Nuclear "${formatStr}" → ${err.type}`);
    }
  }

  return null;
}



/* ======================================================
   MAIN EXPORT
====================================================== */
export async function downloadYouTube({ url, quality, allowAV1, mode }, res, app) {
  const isAudio = mode === "audio";
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), "yt-"));
  app.locals.cancelRequested = false;

  let targetHeight = null;
  const forceH264  = String(quality).startsWith("h264-");
  if (forceH264) {
    const p = parseInt(String(quality).replace("h264-", ""), 10);
    if (!isNaN(p) && p > 0) targetHeight = p;
  } else if (quality && quality !== "best") {
    const p = parseInt(String(quality), 10);
    if (!isNaN(p) && p > 0) targetHeight = p;
  }

  sendLog(app, `▶ Starting YouTube ${isAudio ? "audio" : "video"} download`);
  sendLog(app, `Target: ${targetHeight ? targetHeight + "p" : "Best"} | AV1: ${allowAV1 ? "allowed" : "blocked"}`);

  let resultFile = null;

  if (isAudio) {
    resultFile = await runAudioStrategies({ url, tmpDir, app });
  } else {
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // FIX #3 — allowAV1 finally passed into the engine
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    resultFile = await runVideoStrategies({ url, targetHeight, allowAV1, tmpDir, app });

    if (!resultFile || resultFile === "VIDEO_UNAVAILABLE") {
      if (resultFile !== "VIDEO_UNAVAILABLE") {
        resultFile = await runNuclearFallback({ url, tmpDir, app });
      }
    }
  }

  /* ── CANCELLED ── */
  if (app.locals.cancelRequested) {
    sendLog(app, "Download cancelled");
    safeCleanup(tmpDir);
    return;
  }

  /* ── VIDEO UNAVAILABLE ── */
  if (resultFile === "VIDEO_UNAVAILABLE") {
    sendLog(app, "Video unavailable or removed");
    safeCleanup(tmpDir);
    finishProgress(app);
    if (!res.headersSent)
      return res.status(404).json({ ok: false, error: "Video unavailable or removed" });
    return;
  }

  /* ── SUCCESS ── */
  if (isValidFile(resultFile)) {
    finishProgress(app);
    return streamFile(resultFile, tmpDir, isAudio, res, app);
  }

  /* ── ALL EXHAUSTED ── */
  safeCleanup(tmpDir);
  finishProgress(app);
  sendLog(app, "All strategies exhausted — giving up");

  if (!res.headersSent)
    return res.status(500).json({
      ok: false,
      error: "Download failed on all strategies. Video may be restricted or unavailable."
    });
}



/* ======================================================
   HELPERS
====================================================== */
function streamFile(file, tmpDir, isAudio, res, app) {
  const fileName = path.basename(file);
  const fileSize = fs.statSync(file).size;
  const ext      = path.extname(file).toLowerCase();
  const mimeType = isAudio
    ? "audio/mpeg"
    : ext === ".webm" ? "video/webm" : "video/mp4";

  sendLog(app, `Streaming: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

  if (res.headersSent) { safeCleanup(tmpDir); return; }

  res.setHeader("Content-Type",        mimeType);
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader("Content-Length",      fileSize);
  res.setHeader("Cache-Control",       "no-store");

  const stream = fs.createReadStream(file);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
  res.on("finish", () => {
    safeCleanup(tmpDir);
    sendLog(app, "Cleaned up temp files");
  });
}

function safeCleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function finishProgress(app) {
  const pr = app.locals.progressRes;
  if (pr && !pr.writableEnded) {
    pr.write("data: 100\n\n");
    if (typeof pr.flush === "function") pr.flush();
    pr.end();
    app.locals.progressRes = null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}