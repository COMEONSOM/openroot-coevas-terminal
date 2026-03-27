// ======================================================
// FINAL SERVER (PRODUCTION READY - STABLE BUILD)
// ======================================================

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import { spawn } from "child_process";
import fs, { createReadStream, existsSync, statSync } from "fs";
import os from "os";
import mime from "mime-types";

import { downloadYouTube }     from "./youtube.js";
import { downloadInstagram }   from "./instagram.js";
import { downloadFacebook }    from "./facebook.js";
import { downloadThreads }     from "./threads.js";
import { validateDownloadUrl } from "./utils/validateUrl.js";
import { startYtDlp, startYtDlpInfo } from "./utils/runYtDlp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app          = express();
const DEFAULT_PORT = Number(process.env.PORT) || 3000;

/* ======================================================
   COOKIES — writable path (works in both dev + built .exe)
   In dev:  falls back to server/ folder (source)
   In prod: uses AppData\Roaming\Coevas Terminal\ (writable)
====================================================== */
const COOKIES_DIR = process.env.COEVAS_USER_DATA
  || path.join(os.homedir(), ".coevas");

// Ensure the directory exists
if (!fs.existsSync(COOKIES_DIR)) {
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
}

const COOKIES_FB_INSTA = path.join(COOKIES_DIR, "cookies_fbinsta");
const COOKIES_YOUTUBE  = path.join(COOKIES_DIR, "cookies_youtube.txt");

console.log(`🍪 Cookies dir: ${COOKIES_DIR}`);

let serverInstance = null;

/* ======================================================
   MIDDLEWARE
====================================================== */
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "../public")));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
app.use("/download", limiter);
app.use("/info",     limiter);
app.use("/serve",    limiter);

/* ======================================================
   SSE HELPER
====================================================== */
function sseWrite(res, data) {
  if (!res || res.writableEnded) return;
  res.write(data);
  if (typeof res.flush === "function") res.flush();
}

/* ======================================================
   SSE: PROGRESS  →  GET /progress
====================================================== */
app.get("/progress", (req, res) => {
  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache, no-transform");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  app.locals.progressRes = res;
  sseWrite(res, "data: 0\n\n");

  const hb = setInterval(() => sseWrite(res, ": ping\n\n"), 15_000);

  req.on("close", () => {
    clearInterval(hb);
    if (app.locals.progressRes === res) app.locals.progressRes = null;
  });
});

/* ======================================================
   SSE: LOGS  →  GET /logs
====================================================== */
app.get("/logs", (req, res) => {
  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache, no-transform");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  app.locals.logRes = res;
  sseWrite(res, "data: coevas panel activated successfully! \\n\n\n");

  const hb = setInterval(() => sseWrite(res, ": ping\n\n"), 15_000);

  req.on("close", () => {
    clearInterval(hb);
    if (app.locals.logRes === res) app.locals.logRes = null;
  });
});

/* ======================================================
   CANCEL  →  POST /cancel
====================================================== */
app.post("/cancel", (req, res) => {
  app.locals.cancelRequested = true;
  const proc = app.locals.currentProc;

  if (proc && !proc.killed) {
    try   { proc.kill("SIGTERM"); console.log("Process killed"); }
    catch (e) { console.warn("⚠️ Kill failed:", e.message); }
  }

  if (app.locals.progressRes && !app.locals.progressRes.writableEnded) {
    sseWrite(app.locals.progressRes, "data: 0\n\n");
    app.locals.progressRes.end();
    app.locals.progressRes = null;
  }

  if (app.locals.logRes && !app.locals.logRes.writableEnded) {
    sseWrite(app.locals.logRes, "data: Download canceled by user\\n\n\n");
    app.locals.logRes.end();
    app.locals.logRes = null;
  }

  app.locals.currentProc = null;
  return res.json({ ok: true, message: "Canceled" });
});

/* ======================================================
   HELPERS
====================================================== */
function sendJsonError(res, status = 500, message = "Server error") {
  if (res.headersSent) return;
  return res.status(status).json({ ok: false, error: message });
}

const normalize           = (url = "") => url.toLowerCase();
const isYouTube           = (url) => normalize(url).includes("youtube.com")   || normalize(url).includes("youtu.be");
const isFacebook          = (url) => normalize(url).includes("facebook.com")  || normalize(url).includes("fb.watch");
const isInstagram         = (url) => normalize(url).includes("instagram.com") || normalize(url).includes("instagr.am");
const isThreads           = (url) => { const u = normalize(url); return u.includes("threads.net") || u.includes("threads.com"); };
const isInstagramCarousel = (url) => { const u = normalize(url); return u.includes("instagram.com/p/") || u.includes("instagr.am/p/"); };

/* ======================================================
   YOUTUBE CODEC HELPERS
====================================================== */
function codecRank(vcodec = "") {
  if (vcodec.startsWith("av01")) return 3;
  if (vcodec.startsWith("vp09")) return 2;
  if (vcodec.startsWith("avc1")) return 1;
  return 0;
}

function codecLabel(vcodec = "") {
  if (vcodec.startsWith("av01")) return "AV1";
  if (vcodec.startsWith("vp09")) return "VP9";
  if (vcodec.startsWith("avc1")) return "H.264";
  return vcodec.split(".")[0].toUpperCase();
}

/* ======================================================
   GALLERY-DL: INSTAGRAM CAROUSEL DOWNLOADER
====================================================== */
function downloadInstagramCarousel(url, cookiesPath, res) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-carousel-"));

  const args = [
    "--cookies", cookiesPath,
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "-o", "extractor.instagram.videos=true",
    "-d", tmpDir,
    "--filename", "{username}_{id}_{num}.{extension}",
    url
  ];

  console.log("▶ gallery-dl carousel:", url);

  let stderr = "";
  let proc;

  try {
    proc = spawn("gallery-dl", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    console.error("gallery-dl spawn failed:", err);
    return sendJsonError(res, 500, "gallery-dl not available. Install: pip install gallery-dl");
  }

  const downloadedFiles = [];

  proc.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (fs.existsSync(line)) downloadedFiles.push(line);
    }
  });

  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  proc.on("close", (code) => {
    if (code !== 0 && downloadedFiles.length === 0) {
      console.error("gallery-dl error (code", code, "):", stderr);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return sendJsonError(res, 500, `gallery-dl failed (exit ${code}): ${stderr.slice(0, 300)}`);
    }

    let files = downloadedFiles;
    if (files.length === 0) {
      try {
        files = fs.readdirSync(tmpDir)
          .flatMap(subdir => {
            const full = path.join(tmpDir, subdir);
            if (fs.statSync(full).isDirectory()) {
              return fs.readdirSync(full).map(f => path.join(full, f));
            }
            return [full];
          })
          .filter(f => fs.statSync(f).isFile());
      } catch {}
    }

    if (files.length === 0) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return sendJsonError(res, 404, "No media files found in carousel post");
    }

    console.log(`gallery-dl: ${files.length} file(s) in ${tmpDir}`);

    return res.json({
      ok:    true,
      type:  "carousel",
      count: files.length,
      files: files.map(f => ({
        name: path.basename(f),
        path: f,
        ext:  path.extname(f).replace(".", "").toLowerCase()
      })),
      tmpDir
    });
  });

  proc.on("error", (err) => {
    console.error("gallery-dl process error:", err);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return sendJsonError(res, 500, "gallery-dl process error: " + err.message);
  });
}

/* ======================================================
   /serve — stream a single carousel file to browser
====================================================== */
app.get("/serve", (req, res) => {
  const rawPath = decodeURIComponent(req.query.file || "").trim();

  if (!rawPath || rawPath.includes("..") || !rawPath.startsWith(os.tmpdir())) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  if (!existsSync(rawPath)) {
    return res.status(404).json({ ok: false, error: "File not found" });
  }

  let fileStat;
  try { fileStat = statSync(rawPath); }
  catch { return res.status(500).json({ ok: false, error: "Cannot stat file" }); }

  if (!fileStat.isFile()) {
    return res.status(400).json({ ok: false, error: "Not a file" });
  }

  const fileName = path.basename(rawPath);
  const mimeType = mime.lookup(rawPath) || "application/octet-stream";

  res.setHeader("Content-Type",        mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
  res.setHeader("Content-Length",      fileStat.size);
  res.setHeader("Cache-Control",       "no-store");

  const stream = createReadStream(rawPath);
  stream.on("error", (err) => { console.error("/serve stream error:", err); res.destroy(); });
  stream.pipe(res);

  res.on("finish", () => {
    try { fs.unlinkSync(rawPath); } catch {}
    try {
      const dir = path.dirname(rawPath);
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {}
    console.log(`Cleaned: ${fileName}`);
  });
});

/* ======================================================
   DOWNLOAD ROUTE
====================================================== */
app.post("/download", async (req, res) => {
  const { url, quality, allowAV1 = false, mode = "video" } = req.body || {};

  if (!url)                      return sendJsonError(res, 400, "URL required");
  if (!validateDownloadUrl(url)) return sendJsonError(res, 400, "Invalid URL");

  try {
    if (isYouTube(url))   return await downloadYouTube({ url, quality, allowAV1, mode }, res, app, COOKIES_YOUTUBE);
    if (isFacebook(url))  return await downloadFacebook({ url, mode }, res, app, COOKIES_FB_INSTA);

    if (isInstagram(url)) {
      if (isInstagramCarousel(url)) return downloadInstagramCarousel(url, COOKIES_FB_INSTA, res);
      return await downloadInstagram({ url, mode }, res, app, COOKIES_FB_INSTA);
    }

    if (isThreads(url)) return await downloadThreads({ url, mode }, res, app, COOKIES_FB_INSTA);

    return sendJsonError(res, 400, "Unsupported platform");

  } catch (e) {
    console.error("Download error:", e);
    return sendJsonError(res, 500, "Download failed: " + e.message);
  }
});

/* ======================================================
   INFO ROUTE
====================================================== */
app.post("/info", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return sendJsonError(res, 400, "URL required");

  /* ======================
     META (IG / FB / Threads)
  ====================== */
  if (!isYouTube(url)) {
    let type    = "unknown";
    let handler = "yt-dlp";
    const u     = normalize(url);

    if (u.includes("/reel/") || u.includes("/video/") || u.includes("/tv/")) {
      type    = "video";
      handler = isThreads(url) ? "gallery-dl" : "yt-dlp";
    } else if (u.includes("/p/") || u.includes("/post/")) {
      type    = (isInstagram(url) || isThreads(url)) ? "carousel" : "video";
      handler = (isInstagram(url) || isThreads(url)) ? "gallery-dl" : "yt-dlp";
    }

    return res.json({
      ok:         true,
      platform:   isInstagram(url) ? "instagram"
                : isFacebook(url)  ? "facebook"
                : isThreads(url)   ? "threads"
                : "meta",
      type,
      handler,
      resolution: "Auto",
      codec:      "Not specified",
      size:       null,
      note:       type === "carousel"
        ? "Carousel/photo post — will use gallery-dl to download all media"
        : "Auto-detected (may adjust during download)"
    });
  }

  /* ======================
     YOUTUBE — full format probe
  ====================== */
  const args = ["-J", url];
  let stdout  = "";
  let stderr  = "";
  let proc;

  try {
    proc = startYtDlpInfo(args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    console.error("yt-dlp spawn error:", e);
    return sendJsonError(res, 500, "yt-dlp not available: " + e.message);
  }

  proc.stdout.on("data", (d) => { stdout += d.toString(); });
  proc.stderr.on("data", (d) => {
    stderr += d.toString();
    console.warn("[yt-dlp stderr]", d.toString().trim());
  });

  proc.on("error", (err) => {
    console.error("yt-dlp process error:", err);
    return sendJsonError(res, 500, "yt-dlp process error: " + err.message);
  });

  proc.on("close", (code) => {
    if (!stdout || stdout.trim().length === 0) {
      console.error(`yt-dlp returned no output. Exit: ${code}`);
      return sendJsonError(
        res, 500,
        `yt-dlp returned no data (exit ${code}). ` +
        "Video may be private, age-restricted, or yt-dlp needs updating.\n" +
        stderr.slice(0, 300)
      );
    }

    let info;
    try {
      info = JSON.parse(stdout);
    } catch (e) {
      console.error("Info JSON parse failed:", e.message);
      return sendJsonError(res, 500, "Failed to parse yt-dlp output: " + e.message);
    }

    if (!info) {
      return sendJsonError(res, 500, "yt-dlp returned null info object");
    }

    if (!info.formats && !info.url) {
      return sendJsonError(
        res, 500,
        "No formats found. Video may be private, DRM-protected, or login required."
      );
    }

    const formats = Array.isArray(info.formats) ? info.formats : [];

    // ── STEP 1: adaptive video-only streams ─────────────
    let videoFormats = formats.filter(f =>
      f.height &&
      f.vcodec &&
      f.vcodec !== "none" &&
      (!f.acodec || f.acodec === "none")
    );

    // ── STEP 2: fallback to muxed streams ───────────────
    if (videoFormats.length === 0) {
      videoFormats = formats.filter(f =>
        f.height &&
        f.vcodec &&
        f.vcodec !== "none"
      );
    }

    const duration = Number(info.duration) || 0;

    // ── bestByHeight (AV1 included) ─────────────────────
    const bestByHeightAV1 = {};
    for (const f of videoFormats) {
      const h    = f.height;
      const rank = codecRank(f.vcodec);
      if (
        !bestByHeightAV1[h] ||
        rank > codecRank(bestByHeightAV1[h].vcodec) ||
        (rank === codecRank(bestByHeightAV1[h].vcodec) &&
          (f.tbr || 0) > (bestByHeightAV1[h].tbr || 0))
      ) {
        bestByHeightAV1[h] = f;
      }
    }

    // ── bestByHeight (AV1 excluded) ─────────────────────
    const noAV1Formats = videoFormats.filter(f => !f.vcodec.startsWith("av01"));
    const bestByHeightNoAV1 = {};
    for (const f of noAV1Formats) {
      const h    = f.height;
      const rank = codecRank(f.vcodec);
      if (
        !bestByHeightNoAV1[h] ||
        rank > codecRank(bestByHeightNoAV1[h].vcodec) ||
        (rank === codecRank(bestByHeightNoAV1[h].vcodec) &&
          (f.tbr || 0) > (bestByHeightNoAV1[h].tbr || 0))
      ) {
        bestByHeightNoAV1[h] = f;
      }
    }

    const heights      = Object.keys(bestByHeightAV1).map(Number).sort((a, b) => a - b);
    const maxHeight    = heights.length ? Math.max(...heights) : null;
    const bestFmtAV1   = maxHeight ? bestByHeightAV1[maxHeight]   : null;
    const bestFmtNoAV1 = maxHeight ? bestByHeightNoAV1[maxHeight] : null;

    // ── Size map ─────────────────────────────────────────
    const sizeByHeight = {};
    for (const [h, f] of Object.entries(bestByHeightAV1)) {
      const size =
        f.filesize ||
        f.filesize_approx ||
        (f.tbr && duration ? Math.round((f.tbr * 1000 / 8) * duration) : null);
      if (size) sizeByHeight[Number(h)] = size;
    }

    // ── H.264-only heights ──────────────────────────────
    const h264Heights = [...new Set(
      formats
        .filter(f => f.height && (f.vcodec || "").startsWith("avc1"))
        .map(f => f.height)
    )].sort((a, b) => a - b);

    const bestCodecAV1  = bestFmtAV1   ? codecLabel(bestFmtAV1.vcodec)   : "H.264";
    const bestCodec     = bestFmtNoAV1 ? codecLabel(bestFmtNoAV1.vcodec) : "H.264";

    const codecByHeight = {};
    for (const h of heights) {
      const f = bestByHeightNoAV1[h];
      codecByHeight[h] = f ? codecLabel(f.vcodec) : "H.264";
    }

    return res.json({
      ok:               true,
      platform:         "youtube",
      title:            info.title     || null,
      thumbnail:        info.thumbnail || null,
      maxHeight,
      bestCodecAV1,
      bestCodec,
      codec:            bestCodec,
      codecByHeight,
      availableHeights: heights,
      h264Heights,
      sizeByHeight
    });
  });
});

/* ======================================================
   START SERVER
====================================================== */
export function startServer(port = DEFAULT_PORT) {
  if (serverInstance) return serverInstance;
  serverInstance = app.listen(port, () => {
    console.log(`✅ Server running at http://localhost:${port}`);
  });
  return serverInstance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer();
}
