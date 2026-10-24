// youtube.js — Never-Fail Adaptive Media Extraction Engine
import path from "path";
import os   from "os";
import fs   from "fs";
import { spawnYtDlp } from "./utils/runYtDlp.js";
import { sendLog }     from "./utils/logStream.js";



/* ======================================================
   STRATEGY CONSTANTS
====================================================== */
const DEFAULT_CLIENT = "tv_embedded";
const CLIENTS = ["tv_embedded", "web", "ios", "android"];
const RECOVERABLE_ERRORS = new Set(["HTTP_403", "RATE_LIMITED", "EXTRACTION_FAILED", "GENERIC_FAILURE", "UNKNOWN"]);


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
export function buildFormatTiers(height, allowAV1 = true, forceH264 = false, bestQuality = false) {
  const noAV1 = allowAV1 ? "" : "[vcodec!^=av01]";
  const codec = forceH264 ? "[vcodec^=avc1]" : noAV1;
  const resolution = bestQuality ? `[height>=${height}]` : `[height=${height}]`;
  // Both split-stream and progressive fallbacks retain the same resolution
  // and codec constraints. No selector is allowed to escape the chosen tier.
  return [`bv*${resolution}${codec}+ba/b${resolution}${codec}`];
}



/* ======================================================
   ERROR CLASSIFIER
====================================================== */
export function classifyError(stderr = "", code) {
  if (/HTTP\s+Error\s+403|HTTP\s+403|403\s+Forbidden/i.test(stderr)) return "HTTP_403";
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
export function outputHeight(file) {
  const matches = [...path.basename(file).matchAll(/\[(\d{2,5})x(\d{2,5})\]/g)];
  return matches.length ? Number(matches[matches.length - 1][2]) : null;
}

export function validateOutputResolution(file, { minHeight = null, exactHeight = null } = {}) {
  const height = outputHeight(file);
  if (minHeight && (!height || height < minHeight)) return { valid: false, height };
  if (exactHeight && height !== exactHeight) return { valid: false, height };
  return { valid: true, height };
}

export function spawnAttempt({ client, formatStr, extraArgs = [], url, tmpDir, attemptDir = tmpDir,
  app, isAudio, useCookies = true, noContinue = false, minHeight = null, exactHeight = null,
  spawnProcess = spawnYtDlp }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(attemptDir, { recursive: true });
    const outTmpl = isAudio
      ? path.join(attemptDir, "%(title).80s [%(id)s].%(ext)s")
      : path.join(attemptDir, "%(title).80s [%(resolution)s] [%(format_id)s] [%(id)s].%(ext)s");

    const args = [
      "--newline", "--progress",
      "--no-playlist", "--no-config",
      "-f", formatStr,
      "--merge-output-format", "mp4",
      "-o", outTmpl,
      ...(noContinue ? ["--no-continue"] : []),
      ...extraArgs,
      url
    ];

    let stderr  = "";
    let settled = false;

    const proc = spawnProcess(client, args, { useCookies });
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

      const file = pickBestFile(collectOutputFiles(attemptDir), isAudio);
      if (isValidFile(file)) {
        if (!isAudio) {
          const result = validateOutputResolution(file, { minHeight, exactHeight });
          if (!result.valid) {
            return reject({ type: "QUALITY_MISMATCH", message: `Output ${result.height || "unknown"}p does not meet the selected resolution` });
          }
        }
        return resolve(file);
      }

      reject({ type: classifyError(stderr, code), message: stderr.slice(0, 300), code });
    });
  });
}



/* ======================================================
   VIDEO STRATEGY ENGINE
   FIX #2 — allowAV1 accepted and passed to buildFormatTiers
====================================================== */
export async function runVideoStrategies({ url, targetHeight, bestQuality, forceH264,
  allowAV1, playerClient = DEFAULT_CLIENT, useCookies = true, tmpDir, app,
  attempt = spawnAttempt }) {
  if (!Number.isInteger(targetHeight) || targetHeight <= 0) {
    return { failure: true, type: "QUALITY_UNKNOWN" };
  }

  const label = bestQuality ? `Best (minimum ${targetHeight}p)` : `${targetHeight}p`;
  const formatStr = buildFormatTiers(targetHeight, allowAV1, forceH264, bestQuality)[0];
  const client = playerClient || DEFAULT_CLIENT;
  let lastError = { type: "UNKNOWN" };
  const recoveryAttempts = [
    { attemptDir: tmpDir, noContinue: false, label: "initial" },
    { attemptDir: tmpDir, noContinue: false, label: "resume" },
    { attemptDir: path.join(tmpDir, "fresh-restart"), noContinue: true, label: "fresh restart" },
  ];

  for (let index = 0; index < recoveryAttempts.length; index++) {
    if (app.locals.cancelRequested) return null;
    const recovery = recoveryAttempts[index];
    sendLog(app, `Trying [${client}] ${label} (${recovery.label}) | -f "${formatStr}"`);
    try {
      const file = await attempt({
        client, formatStr, url, tmpDir, attemptDir: recovery.attemptDir,
        app, isAudio: false, useCookies, noContinue: recovery.noContinue,
        minHeight: targetHeight, exactHeight: bestQuality ? null : targetHeight,
      });
      if (isValidFile(file)) {
        sendLog(app, `Success: [${client}] ${label} | -f "${formatStr}"`);
        return file;
      }
    } catch (err) {
      lastError = err || lastError;
      if (err.type === "CANCELLED") return null;
      if (err.type === "VIDEO_UNAVAILABLE") return "VIDEO_UNAVAILABLE";
      if (!RECOVERABLE_ERRORS.has(err.type)) {
        if (err.type === "AUTH_REQUIRED") sendLog(app, "Login required — check the configured YouTube cookies");
        return { failure: true, type: err.type || "UNKNOWN" };
      }
      if (err.type === "RATE_LIMITED" && index < recoveryAttempts.length - 1) {
        sendLog(app, "Rate limited — waiting before same-quality retry");
        await sleep(3000);
      }
      sendLog(app, `↩ [${client}] ${recovery.label} → ${err.type || "UNKNOWN"}`);
    }
  }

  return { failure: true, type: lastError.type || "UNKNOWN" };
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
   MAIN EXPORT
====================================================== */
export async function downloadYouTube({ url, quality, allowAV1, mode, bestHeight, playerClient, useCookies }, res, app) {
  const isAudio = mode === "audio";
  const isBest = !isAudio && (!quality || quality === "best");
  const forceH264 = String(quality).startsWith("h264-");
  let targetHeight = null;
  if (isBest) {
    const parsed = Number(bestHeight);
    if (Number.isInteger(parsed) && parsed > 0) targetHeight = parsed;
  } else if (!isAudio) {
    const parsed = parseInt(String(quality).replace("h264-", ""), 10);
    if (Number.isInteger(parsed) && parsed > 0) targetHeight = parsed;
  }

  if (!isAudio && !targetHeight) {
    return res.status(422).json({
      ok: false,
      error: "Could not verify the highest available resolution for this codec preference. Reanalyze the video and try again.",
    });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-"));
  app.locals.cancelRequested = false;
  sendLog(app, `▶ Starting YouTube ${isAudio ? "audio" : "video"} download`);
  sendLog(app, `Target: ${isAudio ? "Audio" : isBest ? `Best (minimum ${targetHeight}p)` : `${targetHeight}p`} | AV1: ${allowAV1 ? "allowed" : "blocked"}`);

  let resultFile = null;
  if (isAudio) {
    resultFile = await runAudioStrategies({ url, tmpDir, app });
  } else {
    resultFile = await runVideoStrategies({
      url, targetHeight, bestQuality: isBest, forceH264,
      allowAV1: forceH264 ? false : !!allowAV1,
      playerClient, useCookies: useCookies !== false, tmpDir, app,
    });
  }

  if (app.locals.cancelRequested) {
    sendLog(app, "Download cancelled");
    safeCleanup(tmpDir);
    return;
  }

  if (resultFile === "VIDEO_UNAVAILABLE") {
    sendLog(app, "Video unavailable or removed");
    safeCleanup(tmpDir);
    finishProgress(app);
    if (!res.headersSent) return res.status(404).json({ ok: false, error: "Video unavailable or removed" });
    return;
  }

  if (resultFile?.failure) {
    safeCleanup(tmpDir);
    finishProgress(app);
    const error = resultFile.type === "HTTP_403"
      ? `YouTube returned HTTP 403 after three fresh extraction attempts. The selected ${isBest ? `Best quality (minimum ${targetHeight}p)` : `${targetHeight}p`} stream could not be recovered; no lower-resolution file was downloaded. Select a lower resolution and retry if you want to continue.`
      : `The selected ${isBest ? `Best quality (minimum ${targetHeight}p)` : `${targetHeight}p`} stream could not be downloaded (${resultFile.type || "unknown error"}). No lower-resolution file was substituted.`;
    sendLog(app, error);
    if (!res.headersSent) return res.status(502).json({ ok: false, error });
    return;
  }

  if (isValidFile(resultFile)) {
    finishProgress(app);
    return streamFile(resultFile, tmpDir, isAudio, res, app);
  }

  safeCleanup(tmpDir);
  finishProgress(app);
  const error = "The selected video quality could not be downloaded. No lower-resolution file was substituted.";
  sendLog(app, error);
  if (!res.headersSent) return res.status(502).json({ ok: false, error });
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
