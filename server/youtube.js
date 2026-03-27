// youtube.js — Resilient Adaptive Media Extraction Engine
import path from "path";
import os   from "os";
import fs   from "fs";
import { spawnYtDlp } from "./utils/runYtDlp.js";
import { FFMPEG_BIN }  from "./utils/binaryManager.js";
import { sendLog }     from "./utils/logStream.js";

/* ======================================================
   CLIENT ORDER
   tv_embedded → full adaptive (4K VP9) ← primary
   web         → full adaptive           ← fallback 1
   ios         → muxed only              ← fallback 2
   android     → full adaptive           ← fallback 3
====================================================== */
const CLIENTS     = ["tv_embedded", "web", "ios", "android"];
const RESOLUTIONS = [4320, 2160, 1440, 1080, 720, 480, 0];

/* ======================================================
   FORMAT SELECTOR
   Includes muxed fallback for ios client
====================================================== */
function buildFormatSelector(height) {
  if (!height) return "bestvideo+bestaudio/bestvideo/best";
  return [
    `bestvideo[height<=${height}]+bestaudio`,  // adaptive with cap    ← tv_embedded/web/android
    `best[height<=${height}]`,                 // muxed with cap       ← ios
    `bestvideo[height<=1080]+bestaudio`,        // adaptive 1080p       ← downgraded player
    `best[height<=1080]`,                       // muxed 1080p          ← ios downgraded
    `bestvideo+bestaudio`,                      // any adaptive
    `best`                                      // absolute last resort
  ].join("/");
}

function buildSortStr(codecSort) {
  return `res,${codecSort},br`;
}

/* ======================================================
   ERROR CLASSIFIER
====================================================== */
function classifyError(stderr = "", code) {
  if (stderr.includes("Requested format is not available"))  return "FORMAT_UNAVAILABLE";
  if (stderr.includes("Sign in to confirm") ||
      stderr.includes("age-restricted"))                     return "AUTH_REQUIRED";
  if (stderr.includes("Private video") ||
      stderr.includes("removed"))                            return "VIDEO_UNAVAILABLE";
  if (stderr.includes("HTTP Error 429") ||
      stderr.includes("Too Many Requests"))                  return "RATE_LIMITED";
  if (stderr.includes("Unable to extract") ||
      stderr.includes("extraction"))                         return "EXTRACTION_FAILED";
  if (code === 1)                                            return "GENERIC_FAILURE";
  return "UNKNOWN";
}

/* ======================================================
   SINGLE VIDEO ATTEMPT
====================================================== */
function attemptDownload({ client, height, codecSort, url, cookiesPath, tmpDir, app }) {
  return new Promise((resolve, reject) => {
    const outTmpl = path.join(tmpDir, "%(title).80s [%(resolution)s] [%(id)s].%(ext)s");

    const args = [
      "--newline", "--progress",
      "--no-playlist", "--no-config",
      "-f",  buildFormatSelector(height),
      "-S",  buildSortStr(codecSort),
      "--merge-output-format", "mp4",
      "--ffmpeg-location", FFMPEG_BIN,
    ];

    if (cookiesPath && fs.existsSync(cookiesPath)) {
      args.push("--cookies", cookiesPath);
    }

    args.push("-o", outTmpl, url);

    let stderr = "";
    const proc = spawnYtDlp(client, args);
    if (!proc) return reject({ type: "SPAWN_FAILED", message: "Failed to spawn yt-dlp" });

    proc.stdout.on("data", (chunk) => {
      chunk.toString().split("\n").filter(Boolean).forEach(line => {
        sendLog(app, line);
        const match = line.match(/\[download\]\s+([\d.]+)%/);
        if (match) {
          const pr = app.locals.progressRes;
          if (pr && !pr.writableEnded) {
            pr.write(`data: ${parseFloat(match[1])}\n\n`);
            if (typeof pr.flush === "function") pr.flush();
          }
        }
      });
    });

    proc.stderr.on("data", (chunk) => {
      chunk.toString().split("\n").filter(Boolean).forEach(line => {
        if (
          line.includes("frame=")    || line.includes("fps=")  ||
          line.includes("time=")     || line.includes("bitrate=") ||
          line.includes("speed=")    || line.includes("Deno") ||
          line.includes("nsig")      || line.includes("EJS") ||
          line.includes("Extracting")|| line.includes("JS player")
        ) return;
        stderr += line + "\n";
        sendLog(app, `⚠ ${line}`);
      });
    });

    proc.on("error", (err) => reject({ type: "SPAWN_FAILED", message: err.message }));

    proc.on("close", (code) => {
      app.locals.currentProc = null;

      if (app.locals.cancelRequested) return reject({ type: "CANCELLED" });
      if (code !== 0) return reject({ type: classifyError(stderr, code), message: stderr.slice(0, 300), code });

      let files = [];
      try {
        files = fs.readdirSync(tmpDir)
          .filter(f => !f.endsWith(".part") && !f.endsWith(".ytdl"))
          .map(f => path.join(tmpDir, f))
          .filter(f => fs.statSync(f).isFile());
      } catch {}

      const file =
        files.find(f => f.endsWith(".mp4"))  ||
        files.find(f => f.endsWith(".webm")) ||
        files[0];

      if (!file) return reject({ type: "NO_OUTPUT", message: "No output file found" });
      resolve(file);
    });

    app.locals.currentProc = proc;
  });
}

/* ======================================================
   SINGLE AUDIO ATTEMPT
====================================================== */
function attemptAudio({ client, url, cookiesPath, tmpDir, app }) {
  return new Promise((resolve, reject) => {
    const outTmpl = path.join(tmpDir, "%(title).80s [%(id)s].%(ext)s");
    const args = [
      "--newline", "--progress",
      "--no-playlist", "--no-config",
      "-f",              "ba/b",
      "-x",
      "--audio-format",  "mp3",
      "--audio-quality", "0",
      "--ffmpeg-location", FFMPEG_BIN,
    ];

    if (cookiesPath && fs.existsSync(cookiesPath)) args.push("--cookies", cookiesPath);
    args.push("-o", outTmpl, url);

    let stderr = "";
    const proc = spawnYtDlp(client, args);
    if (!proc) return reject({ type: "SPAWN_FAILED" });

    proc.stdout.on("data", (chunk) => {
      chunk.toString().split("\n").filter(Boolean).forEach(line => {
        sendLog(app, line);
        const match = line.match(/\[download\]\s+([\d.]+)%/);
        if (match) {
          const pr = app.locals.progressRes;
          if (pr && !pr.writableEnded) {
            pr.write(`data: ${parseFloat(match[1])}\n\n`);
            if (typeof pr.flush === "function") pr.flush();
          }
        }
      });
    });

    proc.stderr.on("data", d => { stderr += d.toString(); });
    proc.on("error", err => reject({ type: "SPAWN_FAILED", message: err.message }));

    proc.on("close", (code) => {
      if (app.locals.cancelRequested) return reject({ type: "CANCELLED" });
      if (code !== 0) return reject({ type: classifyError(stderr, code), message: stderr.slice(0, 300) });

      let files = [];
      try {
        files = fs.readdirSync(tmpDir)
          .filter(f => !f.endsWith(".part") && !f.endsWith(".ytdl"))
          .map(f => path.join(tmpDir, f))
          .filter(f => fs.statSync(f).isFile());
      } catch {}

      const file =
        files.find(f => f.endsWith(".mp3")) ||
        files.find(f => f.endsWith(".m4a")) ||
        files[0];

      if (!file) return reject({ type: "NO_OUTPUT" });
      resolve(file);
    });

    app.locals.currentProc = proc;
  });
}

/* ======================================================
   MAIN EXPORT
====================================================== */
export async function downloadYouTube({ url, quality, allowAV1, mode }, res, app, cookiesPath) {
  const isAudio = mode === "audio";
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), "yt-"));

  app.locals.cancelRequested = false;

  /* ── Codec preference ── */
  const forceH264 = String(quality).startsWith("h264-");
  let codecSort;
  if (forceH264)     codecSort = "codec:h264";
  else if (allowAV1) codecSort = "codec:av1:vp9:h264";
  else               codecSort = "codec:vp9:h264";

  /* ── Target height ── */
  let targetHeight = null;
  if (forceH264) {
    const p = parseInt(String(quality).replace("h264-", ""), 10);
    if (!isNaN(p) && p > 0) targetHeight = p;
  } else if (quality && quality !== "best") {
    const p = parseInt(String(quality), 10);
    if (!isNaN(p) && p > 0) targetHeight = p;
  }

  /* ── Resolution ladder ── */
  const resLadder = targetHeight
    ? RESOLUTIONS.filter(r => r === 0 || r <= targetHeight)
    : [0];

  sendLog(app, `▶ Starting YouTube ${isAudio ? "audio" : "video"} download`);
  sendLog(app, `Target: ${targetHeight ? targetHeight + "p" : "Best"} | Codec: ${codecSort}`);

  /* ======================================================
     AUDIO — client rotation
  ====================================================== */
  if (isAudio) {
    for (const client of CLIENTS) {
      if (app.locals.cancelRequested) break;
      sendLog(app, `Trying client: ${client}`);
      try {
        const file = await attemptAudio({ client, url, cookiesPath, tmpDir, app });
        finishProgress(app);
        return streamFile(file, tmpDir, true, res, app);
      } catch (err) {
        if (err.type === "CANCELLED")        break;
        if (err.type === "VIDEO_UNAVAILABLE") break;
        sendLog(app, `[${client}] failed: ${err.type}`);
      }
    }

    safeCleanup(tmpDir);
    finishProgress(app);
    if (!res.headersSent)
      return res.status(500).json({ ok: false, error: "Audio download failed on all strategies" });
    return;
  }

  /* ======================================================
     VIDEO — client × resolution strategy matrix
  ====================================================== */
  for (const client of CLIENTS) {
    if (app.locals.cancelRequested) break;

    for (const height of resLadder) {
      if (app.locals.cancelRequested) break;

      const label = height ? `${height}p` : "Best";
      sendLog(app, `Trying ${label} via [${client}]...`);

      try {
        const file = await attemptDownload({
          client, height, codecSort, url, cookiesPath, tmpDir, app
        });

        sendLog(app, `Success: ${label} via [${client}]`);
        finishProgress(app);
        return streamFile(file, tmpDir, false, res, app);

      } catch (err) {
        if (err.type === "CANCELLED") {
          sendLog(app, "Download cancelled");
          safeCleanup(tmpDir);
          return;
        }

        if (err.type === "VIDEO_UNAVAILABLE") {
          sendLog(app, "Video unavailable or removed");
          safeCleanup(tmpDir);
          finishProgress(app);
          if (!res.headersSent)
            return res.status(404).json({ ok: false, error: "Video unavailable or removed" });
          return;
        }

        if (err.type === "AUTH_REQUIRED") {
          sendLog(app, "Login required — add cookies_youtube.txt to ~/.coevas/");
        }

        if (err.type === "RATE_LIMITED") {
          sendLog(app, "Rate limited — waiting 3s...");
          await sleep(3000);
        }

        sendLog(app, `${label} [${client}] → ${err.type} — next strategy`);
      }
    }

    sendLog(app, `Switching from [${client}] → next client`);
  }

  /* ── All strategies exhausted ── */
  safeCleanup(tmpDir);
  finishProgress(app);
  sendLog(app, "All strategies exhausted");

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

  sendLog(app, `Done: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

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
    sendLog(app, "Cleaned up");
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