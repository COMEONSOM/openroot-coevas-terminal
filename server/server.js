// ======================================================
// server.js — COEVAS PANEL (PRODUCTION READY)
// ======================================================

import express           from "express";
import path              from "path";
import { fileURLToPath } from "url";
import rateLimit         from "express-rate-limit";
import { spawn }         from "child_process";
import fs, {
  createReadStream,
  existsSync,
  statSync
}                        from "fs";
import os                from "os";
import mime              from "mime-types";

import { downloadYouTube }     from "./youtube.js";
import { downloadInstagram }   from "./instagram.js";
import { downloadFacebook }    from "./facebook.js";
import { downloadThreads }     from "./threads.js";
import { handleTerabox }       from "./terabox.js";
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
   COOKIES DIR
   ─────────────────────────────────────────────────────
   Resolves to Electron userData on every OS:
     Windows : %APPDATA%\<appName>      (via COEVAS_USER_DATA)
     macOS   : ~/Library/Application Support/<appName>
     Linux   : ~/.config/<appName>

   Cookies are stored here permanently — they survive
   app updates and work on any machine after a build.
   Users import cookies once via the UI; the app handles
   the rest. No manual file copying required.
====================================================== */
const COOKIES_DIR = process.env.COEVAS_USER_DATA
  || path.join(os.homedir(), ".coevas");

if (!fs.existsSync(COOKIES_DIR)) {
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
}

const COOKIES_FB_INSTA = path.join(COOKIES_DIR, "cookies_fbinsta.txt");
const COOKIES_TERABOX  = path.join(COOKIES_DIR, "cookies_terabox.txt");

console.log(`[Coevas]   Cookies dir  : ${COOKIES_DIR}`);
console.log(`[Terabox]  Cookies      : ${fs.existsSync(COOKIES_TERABOX)  ? "found ✓" : "not found — unauthenticated mode"}`);
console.log(`[FB/Insta] Cookies      : ${fs.existsSync(COOKIES_FB_INSTA) ? "found ✓" : "not found"}`);

let serverInstance = null;

/* ======================================================
   MIDDLEWARE
====================================================== */
app.use(express.json({ limit: "4mb" }));  // 4 MB — enough for any cookies file
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
const isTerabox           = (url) => { const u = normalize(url); return (
  u.includes("teraboxapp.com") ||
  u.includes("terabox.app")    ||
  u.includes("terabox.com")    ||
  u.includes("1024tera.com")
); };

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
   COOKIES MANAGEMENT
   ─────────────────────────────────────────────────────
   Three routes let the Electron frontend manage cookie
   files without touching the filesystem directly.
   All cookies are stored inside COOKIES_DIR (userData),
   which is persistent, build-safe, and cross-machine.

   Typical frontend flow:
     1. User clicks "Import Cookies" in Settings
     2. Electron opens a file picker (dialog.showOpenDialog)
     3. Main process reads the file → sends content here
     4. POST /cookies/import validates & saves to userData
     5. GET /cookies/status confirms it's loaded

   Electron main.js IPC example:
     ipcMain.handle("import-cookies", async (e, platform) => {
       const { filePaths, canceled } = await dialog.showOpenDialog({
         title:   `Select ${platform} cookies.txt`,
         filters: [{ name: "Cookies", extensions: ["txt"] }],
       });
       if (canceled || !filePaths.length) return { ok: false };
       const content = fs.readFileSync(filePaths[0], "utf8");
       const r = await fetch("http://localhost:3000/cookies/import", {
         method:  "POST",
         headers: { "Content-Type": "application/json" },
         body:    JSON.stringify({ platform, content }),
       });
       return r.json();
     });
====================================================== */

/**
 * GET /cookies/status
 * Returns which cookie files exist in userData.
 */
app.get("/cookies/status", (req, res) => {
  return res.json({
    ok: true,
    cookies: {
      terabox: fs.existsSync(COOKIES_TERABOX),
      fbinsta: fs.existsSync(COOKIES_FB_INSTA),
    },
    cookiesDir: COOKIES_DIR,
  });
});

/**
 * POST /cookies/import
 * Body: { platform: "terabox" | "fbinsta", content: "<raw Netscape text>" }
 *
 * Validates the content is a proper Netscape cookies file,
 * then writes it to the correct file inside COOKIES_DIR.
 */
app.post("/cookies/import", (req, res) => {
  const { platform, content } = req.body || {};

  if (!platform || !content) {
    return sendJsonError(res, 400, "Both platform and content are required");
  }

  const SUPPORTED = { terabox: COOKIES_TERABOX, fbinsta: COOKIES_FB_INSTA };
  const targetPath = SUPPORTED[platform];

  if (!targetPath) {
    return sendJsonError(res, 400, `Unknown platform "${platform}". Supported: terabox, fbinsta`);
  }

  // Validate Netscape cookie format
  const trimmed   = content.trim();
  const lines     = trimmed.split("\n").map(l => l.trim()).filter(Boolean);
  const dataLines = lines.filter(l => !l.startsWith("#"));

  if (dataLines.length === 0) {
    return sendJsonError(res, 400, "Cookie file appears empty — no data lines found");
  }

  const validLine = dataLines.find(l => l.split("\t").length >= 7);
  if (!validLine) {
    return sendJsonError(
      res, 400,
      "Invalid format — expected Netscape cookies.txt (tab-separated, 7 fields per line). " +
      "Export using a browser extension like 'Get cookies.txt LOCALLY'."
    );
  }

  try {
    fs.writeFileSync(targetPath, trimmed + "\n", "utf8");
    console.log(`[Cookies] Imported ${platform} → ${targetPath} (${dataLines.length} entries)`);

    return res.json({
      ok:      true,
      platform,
      entries: dataLines.length,
      savedTo: targetPath,
      message: `${platform} cookies imported (${dataLines.length} entries)`,
    });
  } catch (err) {
    console.error("[Cookies] Write error:", err.message);
    return sendJsonError(res, 500, "Failed to save cookie file: " + err.message);
  }
});

/**
 * DELETE /cookies/:platform
 * Removes the cookie file for the given platform from userData.
 */
app.delete("/cookies/:platform", (req, res) => {
  const { platform } = req.params;
  const SUPPORTED    = { terabox: COOKIES_TERABOX, fbinsta: COOKIES_FB_INSTA };
  const targetPath   = SUPPORTED[platform];

  if (!targetPath) {
    return sendJsonError(res, 400, `Unknown platform "${platform}"`);
  }

  if (!fs.existsSync(targetPath)) {
    return res.json({ ok: true, message: `No ${platform} cookies to remove` });
  }

  try {
    fs.unlinkSync(targetPath);
    console.log(`[Cookies] Removed ${platform} cookies`);
    return res.json({ ok: true, message: `${platform} cookies removed` });
  } catch (err) {
    return sendJsonError(res, 500, "Failed to remove cookie file: " + err.message);
  }
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

    if (isTerabox(url)) {
      const result = await handleTerabox(url, COOKIES_TERABOX);

      if (!result.success) {
        return sendJsonError(res, 500, result.error || "Terabox download failed");
      }

      return res.json({
        ok:       true,
        platform: "terabox",
        type:     "files",
        count:    result.count,
        files:    result.files,
        tmpDir:   result.tmpDir,
      });
    }

    return sendJsonError(res, 400, "Unsupported platform — YouTube, Instagram, Facebook, Threads, Terabox only");

  } catch (e) {
    console.error("Download error:", e);
    return sendJsonError(res, 500, "Download failed: " + e.message);
  }
});

/* ======================================================
   INFO PROBE HELPER
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

    if (isTerabox(url)) {
      return res.json({
        ok:       true,
        platform: "terabox",
        type:     "file-list",
        handler:  "internal-api",
        note: fs.existsSync(COOKIES_TERABOX)
          ? "Authenticated — cookies_terabox loaded ✓"
          : "Public shared files only — import cookies via Settings for private links",
      });
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
    console.log(`[Coevas] Server running at http://localhost:${port}`);
  });
  return serverInstance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer();
}