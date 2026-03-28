// ======================================================
// server.js — FINAL SERVER (PRODUCTION READY)
// ======================================================

import express         from "express";
import path            from "path";
import { fileURLToPath } from "url";
import rateLimit       from "express-rate-limit";
import { spawn }       from "child_process";
import fs, {
  createReadStream,
  existsSync,
  statSync
}                      from "fs";
import os              from "os";
import mime            from "mime-types";

import { downloadYouTube }     from "./youtube.js";
import { downloadInstagram }   from "./instagram.js";
import { downloadFacebook }    from "./facebook.js";
import { downloadThreads }     from "./threads.js";
import { validateDownloadUrl } from "./utils/validateUrl.js";
import {
  spawnYtDlpProbe,
  spawnYtDlpProbeNoCookies
}                              from "./utils/runYtDlp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app          = express();
const DEFAULT_PORT = Number(process.env.PORT) || 3000;

/* ======================================================
   COOKIES
====================================================== */
const COOKIES_DIR = process.env.COEVAS_USER_DATA
  || path.join(os.homedir(), ".coevas");

if (!fs.existsSync(COOKIES_DIR)) {
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
}

const COOKIES_FB_INSTA = path.join(COOKIES_DIR, "cookies_fbinsta");

console.log(`Cookies dir: ${COOKIES_DIR}`);

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
   GET /progress
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
   GET /logs
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
   POST /cancel
====================================================== */
app.post("/cancel", (req, res) => {
  app.locals.cancelRequested = true;
  const proc = app.locals.currentProc;

  if (proc && !proc.killed) {
    try   { proc.kill("SIGTERM"); console.log("Process killed"); }
    catch (e) { console.warn("Kill failed:", e.message); }
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
   CODEC HELPERS
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
   GALLERY-DL: INSTAGRAM CAROUSEL
====================================================== */
function downloadInstagramCarousel(url, cookiesPath, res) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-carousel-"));

  const args = [
    "--cookies",    cookiesPath,
    "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "-o",           "extractor.instagram.videos=true",
    "-d",           tmpDir,
    "--filename",   "{username}_{id}_{num}.{extension}",
    url
  ];

  let stderr = "";
  let proc;

  try {
    proc = spawn("gallery-dl", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return sendJsonError(res, 500, "gallery-dl not available. Install: pip install gallery-dl");
  }

  const downloadedFiles = [];

  proc.stdout.on("data", (chunk) => {
    chunk.toString().split("\n").map(l => l.trim()).filter(Boolean).forEach(line => {
      if (fs.existsSync(line)) downloadedFiles.push(line);
    });
  });

  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  proc.on("close", (code) => {
    if (code !== 0 && downloadedFiles.length === 0) {
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
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return sendJsonError(res, 500, "gallery-dl process error: " + err.message);
  });
}

/* ======================================================
   GET /serve
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
  try   { fileStat = statSync(rawPath); }
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
  stream.on("error", () => res.destroy());
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
   POST /download
====================================================== */
app.post("/download", async (req, res) => {
  const { url, quality, allowAV1 = false, mode = "video" } = req.body || {};

  if (!url)                      return sendJsonError(res, 400, "URL required");
  if (!validateDownloadUrl(url)) return sendJsonError(res, 400, "Invalid URL");

  try {
    if (isYouTube(url))
      return await downloadYouTube({ url, quality, allowAV1, mode }, res, app);

    if (isFacebook(url))
      return await downloadFacebook({ url, mode }, res, app, COOKIES_FB_INSTA);

    if (isInstagram(url)) {
      if (isInstagramCarousel(url))
        return downloadInstagramCarousel(url, COOKIES_FB_INSTA, res);
      return await downloadInstagram({ url, mode }, res, app, COOKIES_FB_INSTA);
    }

    if (isThreads(url))
      return await downloadThreads({ url, mode }, res, app, COOKIES_FB_INSTA);

    return sendJsonError(res, 400, "Unsupported platform");

  } catch (e) {
    console.error("Download error:", e);
    return sendJsonError(res, 500, "Download failed: " + e.message);
  }
});

/* ======================================================
   INFO PROBE HELPER
   Never throws — always returns parsed object or null
====================================================== */
const INFO_CLIENTS = ["tv_embedded", "web", "ios", "android", "mweb", "web_creator"];

function probeInfo(client, url, useCookies = true) {
  return new Promise((resolve) => {
    let stdout = "";

    let proc;
    try {
      proc = useCookies
        ? spawnYtDlpProbe(client, ["-J", url])
        : spawnYtDlpProbeNoCookies(client, ["-J", url]);
    } catch (e) {
      console.error(`[Info/${client}] spawn error:`, e.message);
      return resolve(null);
    }

    if (!proc) return resolve(null);

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });

    proc.stderr.on("data", (chunk) => {
      chunk.toString().split("\n").filter(Boolean).forEach(line =>
        console.warn(`[Info/${client}${useCookies ? "" : "/no-cookies"}]`, line)
      );
    });

    proc.on("error", (err) => {
      console.error(`[Info/${client}] process error:`, err.message);
      resolve(null);
    });

    proc.on("close", () => {
      if (!stdout || stdout.trim().length === 0) {
        console.log(`[Info/${client}] no stdout — skipping`);
        return resolve(null);
      }

      // Debug: show what yt-dlp actually returned
      console.log(`[Info/${client}] stdout preview: ${stdout.trim().slice(0, 120)}`);

      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        console.log(`[Info/${client}] JSON parse failed — skipping`);
        return resolve(null);
      }

      if (!parsed || !parsed.id) {
        console.log(`[Info/${client}] no valid id — skipping (got: ${JSON.stringify(parsed)?.slice(0, 80)})`);
        return resolve(null);
      }

      resolve(parsed);
    });
  });
}

/* ======================================================
   POST /info
====================================================== */
app.post("/info", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return sendJsonError(res, 400, "URL required");

  /* ── Non-YouTube ── */
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

  /* ── YouTube: Round 1 — with cookies ── */
  let info = null;

  console.log("[Info] Round 1: probing with cookies...");
  for (const client of INFO_CLIENTS) {
    console.log(`[Info] Trying client: ${client}`);
    info = await probeInfo(client, url, true);
    if (info) {
      console.log(`[Info] Success with client: ${client}`);
      break;
    }
    console.log(`[Info] ✗ ${client} failed — trying next`);
  }

  /* ── YouTube: Round 2 — without cookies ── */
  if (!info) {
    console.log("[Info] Round 2: retrying WITHOUT cookies (stale cookie check)...");
    for (const client of INFO_CLIENTS) {
      console.log(`[Info] Trying client (no-cookies): ${client}`);
      info = await probeInfo(client, url, false);
      if (info) {
        console.log(`[Info] Success (no-cookies) with client: ${client}`);
        console.warn("[Info] ⚠ Cookie-less probe succeeded — cookies_youtube.txt may be expired");
        break;
      }
      console.log(`[Info] ✗ ${client} (no-cookies) failed — trying next`);
    }
  }

  /* ── All probes exhausted — graceful degradation ── */
  if (!info) {
    console.warn("[Info] All clients exhausted — returning degraded response");
    return res.json({
      ok:               true,
      platform:         "youtube",
      degraded:         true,
      title:            null,
      thumbnail:        null,
      maxHeight:        null,
      bestCodecAV1:     "Unknown",
      bestCodec:        "Unknown",
      codec:            "Unknown",
      codecByHeight:    {},
      availableHeights: [],
      h264Heights:      [],
      sizeByHeight:     {},
      note: "Format info unavailable — download will still be attempted automatically"
    });
  }

  /* ── Parse formats ── */
  const formats  = Array.isArray(info.formats) ? info.formats : [];
  const duration = Number(info.duration) || 0;

  let videoFormats = formats.filter(f =>
    f.height &&
    f.vcodec && f.vcodec !== "none" &&
    (!f.acodec || f.acodec === "none")
  );

  if (videoFormats.length === 0) {
    videoFormats = formats.filter(f =>
      f.height && f.vcodec && f.vcodec !== "none"
    );
  }

  const bestByHeightAV1 = {};
  for (const f of videoFormats) {
    const h = f.height, rank = codecRank(f.vcodec), prev = bestByHeightAV1[h];
    if (!prev || rank > codecRank(prev.vcodec) ||
        (rank === codecRank(prev.vcodec) && (f.tbr || 0) > (prev.tbr || 0))) {
      bestByHeightAV1[h] = f;
    }
  }

  const bestByHeightNoAV1 = {};
  for (const f of videoFormats.filter(f => !f.vcodec.startsWith("av01"))) {
    const h = f.height, rank = codecRank(f.vcodec), prev = bestByHeightNoAV1[h];
    if (!prev || rank > codecRank(prev.vcodec) ||
        (rank === codecRank(prev.vcodec) && (f.tbr || 0) > (prev.tbr || 0))) {
      bestByHeightNoAV1[h] = f;
    }
  }

  const heights      = Object.keys(bestByHeightAV1).map(Number).sort((a, b) => a - b);
  const maxHeight    = heights.length ? Math.max(...heights) : null;
  const bestFmtAV1   = maxHeight ? bestByHeightAV1[maxHeight]   : null;
  const bestFmtNoAV1 = maxHeight ? bestByHeightNoAV1[maxHeight] : null;

  const sizeByHeight = {};
  for (const [h, f] of Object.entries(bestByHeightAV1)) {
    const size =
      f.filesize ||
      f.filesize_approx ||
      (f.tbr && duration ? Math.round((f.tbr * 1000 / 8) * duration) : null);
    if (size) sizeByHeight[Number(h)] = size;
  }

  const h264Heights = [...new Set(
    formats
      .filter(f => f.height && (f.vcodec || "").startsWith("avc1"))
      .map(f => f.height)
  )].sort((a, b) => a - b);

  const bestCodecAV1 = bestFmtAV1   ? codecLabel(bestFmtAV1.vcodec)   : "H.264";
  const bestCodec    = bestFmtNoAV1 ? codecLabel(bestFmtNoAV1.vcodec) : "H.264";

  const codecByHeight = {};
  for (const h of heights) {
    const f = bestByHeightNoAV1[h];
    codecByHeight[h] = f ? codecLabel(f.vcodec) : "H.264";
  }

  return res.json({
    ok:               true,
    platform:         "youtube",
    degraded:         false,
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

/* ======================================================
   START SERVER
====================================================== */
export function startServer(port = DEFAULT_PORT) {
  if (serverInstance) return serverInstance;
  serverInstance = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
  return serverInstance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer();
}