// ======================================================
// server.js — COEVAS PANEL (PRODUCTION READY)
// ======================================================
import 'dotenv/config';
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
import https             from "https";
import http              from "http";
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
   AUTO-UPDATE CONFIGURATION
====================================================== */
const CURRENT_VERSION   = process.env.APP_VERSION   || "1.0.0";
const GITHUB_OWNER      = process.env.GITHUB_OWNER  || "your-username";
const GITHUB_REPO       = process.env.GITHUB_REPO   || "coevas";
const GITHUB_API_BASE   = "https://api.github.com";
const UPDATE_TEMP_DIR   = path.join(os.tmpdir(), "coevas-update");

const updateState = {
  downloading:    false,
  downloadedPath: null,
  latestVersion:  null,
  progressRes:    null,
};

console.log(`[Coevas]   Version      : ${CURRENT_VERSION}`);
console.log(`[Coevas]   Update repo  : ${GITHUB_OWNER}/${GITHUB_REPO}`);

/* ======================================================
   MIDDLEWARE
====================================================== */
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "../public")));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
app.use("/download",        limiter);
app.use("/info",            limiter);
app.use("/serve",           limiter);
app.use("/update/download", rateLimit({ windowMs: 60 * 1000, max: 3 }));

/* ======================================================
   SSE HELPER
====================================================== */
function sseWrite(res, data) {
  if (!res || res.writableEnded) return;
  res.write(data);
  if (typeof res.flush === "function") res.flush();
}

function sseSetup(res) {
  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache, no-transform");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

/* ======================================================
   GET /progress
====================================================== */
app.get("/progress", (req, res) => {
  sseSetup(res);
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
  sseSetup(res);
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

const normalize      = (url = "") => url.toLowerCase();
const isYouTube      = (url) => normalize(url).includes("youtube.com") || normalize(url).includes("youtu.be");
const isFacebook     = (url) => normalize(url).includes("facebook.com") || normalize(url).includes("fb.watch");
const isInstagram    = (url) => normalize(url).includes("instagram.com") || normalize(url).includes("instagr.am");
const isThreads      = (url) => { const u = normalize(url); return u.includes("threads.net") || u.includes("threads.com"); };
const isTerabox      = (url) => { const u = normalize(url); return u.includes("teraboxapp.com") || u.includes("terabox.app") || u.includes("terabox.com") || u.includes("1024tera.com"); };

const isFacebookReelOrVideo = (url) => {
  const u = normalize(url);
  return u.includes("facebook.com/reel/") || u.includes("facebook.com/watch/") ||
         u.includes("facebook.com/videos/") || u.includes("facebook.com/video.php") || u.includes("facebook.com/v/");
};
const isInstagramReelOrVideo = (url) => {
  const u = normalize(url);
  return u.includes("instagram.com/reel/") || u.includes("instagram.com/tv/") ||
         u.includes("instagr.am/reel/") || u.includes("instagr.am/tv/");
};

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
   VERSION HELPER
====================================================== */
function isNewer(current, latest) {
  const parse = (v) => (v || "0.0.0").replace(/^v/i, "").split(".").map(n => parseInt(n, 10) || 0);
  const [cMaj, cMin, cPat] = parse(current);
  const [lMaj, lMin, lPat] = parse(latest);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

/* ======================================================
   HTTP GET HELPER
====================================================== */
function httpGet(url, extraHeaders = {}, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
    const lib     = url.startsWith("https") ? https : http;
    const options = { headers: { "User-Agent": `Coevas/${CURRENT_VERSION} (auto-updater)`, ...extraHeaders } };
    lib.get(url, options, (res) => {
      const { statusCode, headers } = res;
      if ([301,302,303,307,308].includes(statusCode) && headers.location) {
        res.resume();
        return resolve(httpGet(headers.location, extraHeaders, redirectsLeft - 1));
      }
      const chunks = [];
      res.on("data",  (c) => chunks.push(c));
      res.on("end",   ()  => resolve({ statusCode, headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    }).on("error", reject);
  });
}

/* ======================================================
   GITHUB RELEASE HELPER
====================================================== */
async function fetchLatestRelease() {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
  const { statusCode, body } = await httpGet(url, {
    Accept: "application/vnd.github+json",
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  });
  if (statusCode !== 200) throw new Error(`GitHub API returned HTTP ${statusCode}`);
  return JSON.parse(body.toString("utf8"));
}

function pickAsset(assets = []) {
  const platform = os.platform();
  const exts = { win32: [".exe"], darwin: [".dmg", ".pkg"], linux: [".AppImage", ".deb"] }[platform] || [".exe"];
  for (const ext of exts) {
    const asset = assets.find(a => a.name.toLowerCase().endsWith(ext) && a.state === "uploaded");
    if (asset) return asset;
  }
  return assets.find(a => a.state === "uploaded") || null;
}

/* ======================================================
   AUTO-UPDATE ROUTES
====================================================== */
app.get("/update/check", async (req, res) => {
  try {
    const release = await fetchLatestRelease();
    const latestVersion  = (release.tag_name || "").replace(/^v/i, "");
    const updateAvailable = isNewer(CURRENT_VERSION, latestVersion);
    const asset = pickAsset(release.assets || []);
    updateState.latestVersion = latestVersion;
    return res.json({
      ok: true, updateAvailable,
      currentVersion: CURRENT_VERSION, latestVersion,
      releaseNotes:   release.body || "",
      assetName:      asset?.name || null,
      downloadUrl:    asset?.browser_download_url || null,
      publishedAt:    release.published_at || null,
    });
  } catch (err) {
    console.error("[Update/check] Error:", err.message);
    return res.json({ ok: false, updateAvailable: false, currentVersion: CURRENT_VERSION, error: err.message });
  }
});

app.get("/update/progress", (req, res) => {
  sseSetup(res);
  updateState.progressRes = res;
  sseWrite(res, `data: ${JSON.stringify({ percent: 0 })}\n\n`);
  const hb = setInterval(() => sseWrite(res, ": ping\n\n"), 15_000);
  req.on("close", () => { clearInterval(hb); if (updateState.progressRes === res) updateState.progressRes = null; });
});

app.post("/update/download", async (req, res) => {
  const { downloadUrl } = req.body || {};
  if (!downloadUrl) return sendJsonError(res, 400, "downloadUrl required");
  if (updateState.downloading) return sendJsonError(res, 409, "Download already in progress");
  if (!downloadUrl.includes("github.com") && !downloadUrl.includes("objects.githubusercontent.com"))
    return sendJsonError(res, 400, "Only GitHub release asset URLs are accepted");

  try {
    if (!fs.existsSync(UPDATE_TEMP_DIR)) fs.mkdirSync(UPDATE_TEMP_DIR, { recursive: true });
    fs.readdirSync(UPDATE_TEMP_DIR).forEach(f => { try { fs.unlinkSync(path.join(UPDATE_TEMP_DIR, f)); } catch {} });
  } catch (e) { return sendJsonError(res, 500, "Cannot prepare temp directory: " + e.message); }

  const filename   = decodeURIComponent(downloadUrl.split("/").pop().split("?")[0]) || "coevas-update.exe";
  const destPath   = path.join(UPDATE_TEMP_DIR, filename);
  const fileStream = fs.createWriteStream(destPath);

  updateState.downloading    = true;
  updateState.downloadedPath = null;
  res.json({ ok: true, message: "Download started", filename });

  function sendUpdateProgress(data) {
    if (updateState.progressRes && !updateState.progressRes.writableEnded)
      sseWrite(updateState.progressRes, `data: ${JSON.stringify(data)}\n\n`);
  }

  async function doDownload(url, redirectsLeft = 10) {
    if (redirectsLeft <= 0) throw new Error("Too many redirects");
    return new Promise((resolve, reject) => {
      const lib = url.startsWith("https") ? https : http;
      lib.get(url, { headers: { "User-Agent": `Coevas/${CURRENT_VERSION} (auto-updater)`, Accept: "application/octet-stream" } }, (response) => {
        const { statusCode, headers } = response;
        if ([301,302,303,307,308].includes(statusCode) && headers.location) {
          response.resume();
          return resolve(doDownload(headers.location, redirectsLeft - 1));
        }
        if (statusCode !== 200) { response.resume(); return reject(new Error(`HTTP ${statusCode}`)); }
        const totalBytes = parseInt(headers["content-length"] || "0", 10);
        let bytesReceived = 0, lastPct = -1;
        response.on("data", chunk => {
          bytesReceived += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.floor((bytesReceived / totalBytes) * 100);
            if (pct !== lastPct) { lastPct = pct; sendUpdateProgress({ percent: pct, bytesReceived, totalBytes }); }
          } else sendUpdateProgress({ percent: -1, bytesReceived, totalBytes: null });
        });
        response.on("error", reject);
        response.pipe(fileStream);
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
      }).on("error", reject);
    });
  }

  try {
    await doDownload(downloadUrl);
    updateState.downloadedPath = destPath;
    updateState.downloading    = false;
    sendUpdateProgress({ done: true, savedTo: destPath });
  } catch (err) {
    updateState.downloading = false;
    try { fs.unlinkSync(destPath); } catch {}
    sendUpdateProgress({ error: err.message });
  }
});

app.post("/update/apply", (req, res) => {
  const installer = updateState.downloadedPath;
  if (!installer) return sendJsonError(res, 400, "No installer ready");
  if (!fs.existsSync(installer)) { updateState.downloadedPath = null; return sendJsonError(res, 404, "Installer missing"); }
  try {
    const platform = os.platform();
    let child;
    if (platform === "win32")
      child = spawn(installer, ["/S", "/NCRC"], { detached: true, stdio: "ignore", windowsHide: false });
    else if (platform === "darwin")
      child = spawn("open", ["-W", installer], { detached: true, stdio: "ignore" });
    else { try { fs.chmodSync(installer, 0o755); } catch {}; child = spawn(installer, [], { detached: true, stdio: "ignore" }); }
    child.unref();
    res.json({ ok: true, message: "Installer launched — app will restart" });
    setTimeout(() => {
      if (typeof process.emit === "function" && process.listenerCount("coevas-apply-update") > 0) {
        process.emit("coevas-apply-update"); return;
      }
      process.exit(0);
    }, 300);
  } catch (err) {
    return sendJsonError(res, 500, "Failed to launch installer: " + err.message);
  }
});

app.delete("/update/cancel", (req, res) => {
  updateState.downloading = false; updateState.downloadedPath = null;
  try {
    if (fs.existsSync(UPDATE_TEMP_DIR))
      fs.readdirSync(UPDATE_TEMP_DIR).forEach(f => { try { fs.unlinkSync(path.join(UPDATE_TEMP_DIR, f)); } catch {} });
  } catch {}
  if (updateState.progressRes && !updateState.progressRes.writableEnded) {
    sseWrite(updateState.progressRes, `data: ${JSON.stringify({ canceled: true })}\n\n`);
    updateState.progressRes.end(); updateState.progressRes = null;
  }
  return res.json({ ok: true, message: "Update download canceled" });
});

/* ======================================================
   GET /serve
====================================================== */
app.get("/serve", (req, res) => {
  const rawPath = decodeURIComponent(req.query.file || "").trim();
  if (!rawPath || rawPath.includes("..") || !rawPath.startsWith(os.tmpdir()))
    return res.status(403).json({ ok: false, error: "Forbidden" });
  if (!existsSync(rawPath))
    return res.status(404).json({ ok: false, error: "File not found" });
  let fileStat;
  try   { fileStat = statSync(rawPath); }
  catch { return res.status(500).json({ ok: false, error: "Cannot stat file" }); }
  if (!fileStat.isFile())
    return res.status(400).json({ ok: false, error: "Not a file" });

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
    try { const dir = path.dirname(rawPath); if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
  });
});

/* ======================================================
   COOKIES MANAGEMENT
====================================================== */
app.get("/cookies/status", (req, res) => {
  return res.json({
    ok: true,
    cookies: { terabox: fs.existsSync(COOKIES_TERABOX), fbinsta: fs.existsSync(COOKIES_FB_INSTA) },
    cookiesDir: COOKIES_DIR,
  });
});

app.post("/cookies/import", (req, res) => {
  const { platform, content } = req.body || {};
  if (!platform || !content) return sendJsonError(res, 400, "Both platform and content are required");
  const SUPPORTED = { terabox: COOKIES_TERABOX, fbinsta: COOKIES_FB_INSTA };
  const targetPath = SUPPORTED[platform];
  if (!targetPath) return sendJsonError(res, 400, `Unknown platform "${platform}"`);
  const trimmed   = content.trim();
  const lines     = trimmed.split("\n").map(l => l.trim()).filter(Boolean);
  const dataLines = lines.filter(l => !l.startsWith("#"));
  if (dataLines.length === 0) return sendJsonError(res, 400, "Cookie file appears empty");
  const validLine = dataLines.find(l => l.split("\t").length >= 7);
  if (!validLine) return sendJsonError(res, 400, "Invalid format — expected Netscape cookies.txt");
  try {
    fs.writeFileSync(targetPath, trimmed + "\n", "utf8");
    return res.json({ ok: true, platform, entries: dataLines.length, savedTo: targetPath });
  } catch (err) {
    return sendJsonError(res, 500, "Failed to save cookie file: " + err.message);
  }
});

app.delete("/cookies/:platform", (req, res) => {
  const { platform } = req.params;
  const SUPPORTED = { terabox: COOKIES_TERABOX, fbinsta: COOKIES_FB_INSTA };
  const targetPath = SUPPORTED[platform];
  if (!targetPath) return sendJsonError(res, 400, `Unknown platform "${platform}"`);
  if (!fs.existsSync(targetPath)) return res.json({ ok: true, message: `No ${platform} cookies to remove` });
  try { fs.unlinkSync(targetPath); return res.json({ ok: true, message: `${platform} cookies removed` }); }
  catch (err) { return sendJsonError(res, 500, "Failed to remove cookie file: " + err.message); }
});

/* ======================================================
   POST /download
   ─────────────────────────────────────────────────────
   KEY FIX: All Instagram URLs go to downloadInstagram()
   from instagram.js — there is NO local carousel
   function anymore. instagram.js handles both /p/ and
   /reel/ and returns a single ZIP when there are multiple
   files. Same for Threads and Facebook.
====================================================== */
app.post("/download", async (req, res) => {
  const { url, quality, allowAV1 = false, mode = "video" } = req.body || {};

  if (!url)                      return sendJsonError(res, 400, "URL required");
  if (!validateDownloadUrl(url)) return sendJsonError(res, 400, "Invalid URL");

  try {
    // YouTube
    if (isYouTube(url))
      return await downloadYouTube({ url, quality, allowAV1, mode }, res, app);

    // Facebook — always use facebook.js (handles all post types + yt-dlp fallback)
    if (isFacebook(url))
      return await downloadFacebook({ url, mode }, res, app, COOKIES_FB_INSTA);

    // Instagram — always use instagram.js
    // instagram.js internally routes /p/ → gallery-dl (ZIP if multiple)
    //                                /reel/ /tv/ → yt-dlp
    // NO local downloadInstagramCarousel — that function is removed.
    if (isInstagram(url))
      return await downloadInstagram({ url, mode }, res, app, COOKIES_FB_INSTA);

    // Threads — threads.js streams single file or ZIP
    if (isThreads(url))
      return await downloadThreads({ url, mode }, res, app, COOKIES_FB_INSTA);

    // Terabox
    if (isTerabox(url)) {
      const result = await handleTerabox(url, COOKIES_TERABOX);
      if (!result.success) return sendJsonError(res, 500, result.error || "Terabox download failed");
      return res.json({ ok: true, platform: "terabox", type: "files", count: result.count, files: result.files, tmpDir: result.tmpDir });
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
const INFO_CLIENTS = ["tv_embedded","web","ios","android","mweb","web_creator"];

function probeInfo(client, url, useCookies = true) {
  return new Promise((resolve) => {
    let stdout = "";
    let proc;
    try {
      proc = useCookies
        ? spawnYtDlpProbe(client, ["-J", url])
        : spawnYtDlpProbeNoCookies(client, ["-J", url]);
    } catch (e) { console.error(`[Info/${client}] spawn error:`, e.message); return resolve(null); }
    if (!proc) return resolve(null);
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => {
      chunk.toString().split("\n").filter(Boolean).forEach(line =>
        console.warn(`[Info/${client}${useCookies ? "" : "/no-cookies"}]`, line)
      );
    });
    proc.on("error", (err) => { console.error(`[Info/${client}] process error:`, err.message); resolve(null); });
    proc.on("close", () => {
      if (!stdout?.trim()) return resolve(null);
      let parsed;
      try { parsed = JSON.parse(stdout); } catch { return resolve(null); }
      if (!parsed?.id) return resolve(null);
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

  if (!isYouTube(url)) {
    if (isTerabox(url))
      return res.json({ ok: true, platform: "terabox", type: "file-list", handler: "internal-api",
        note: fs.existsSync(COOKIES_TERABOX) ? "Authenticated ✓" : "Public files only" });

    if (isFacebook(url))
      return res.json({ ok: true, platform: "facebook", type: isFacebookReelOrVideo(url) ? "video" : "carousel",
        handler: "facebook", resolution: "Auto", codec: "Not specified", size: null,
        note: "Single media streams directly, multiple media are zipped" });

    if (isInstagram(url))
      return res.json({ ok: true, platform: "instagram", type: isInstagramReelOrVideo(url) ? "video" : "carousel",
        handler: isInstagramReelOrVideo(url) ? "yt-dlp" : "gallery-dl", resolution: "Auto", codec: "Not specified", size: null,
        note: "Single media streams directly, multiple media are zipped" });

    if (isThreads(url))
      return res.json({ ok: true, platform: "threads", type: "carousel", handler: "threads",
        resolution: "Auto", codec: "Not specified", size: null,
        note: "Single media streams directly, multiple media are zipped" });

    return res.json({ ok: true, platform: "meta", type: "carousel", handler: "facebook",
      resolution: "Auto", codec: "Not specified", size: null,
      note: "Single media streams directly, multiple media are zipped" });
  }

  // YouTube probing
  let info = null;
  console.log("[Info] Round 1: probing with cookies...");
  for (const client of INFO_CLIENTS) {
    info = await probeInfo(client, url, true);
    if (info) { console.log(`[Info] Success with client: ${client}`); break; }
  }
  if (!info) {
    console.log("[Info] Round 2: retrying WITHOUT cookies...");
    for (const client of INFO_CLIENTS) {
      info = await probeInfo(client, url, false);
      if (info) { console.log(`[Info] Success (no-cookies): ${client}`); break; }
    }
  }

  if (!info) {
    return res.json({
      ok: true, platform: "youtube", degraded: true,
      title: null, thumbnail: null, maxHeight: null,
      bestCodecAV1: "Unknown", bestCodec: "Unknown", codec: "Unknown",
      codecByHeight: {}, availableHeights: [], h264Heights: [], sizeByHeight: {},
      note: "Format info unavailable — download will still be attempted automatically",
    });
  }

  const formats  = Array.isArray(info.formats) ? info.formats : [];
  const duration = Number(info.duration) || 0;

  let videoFormats = formats.filter(f => f.height && f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none"));
  if (videoFormats.length === 0) videoFormats = formats.filter(f => f.height && f.vcodec && f.vcodec !== "none");

  const buildBestByHeight = (fmts) => {
    const map = {};
    for (const f of fmts) {
      const h = f.height, rank = codecRank(f.vcodec), prev = map[h];
      if (!prev || rank > codecRank(prev.vcodec) || (rank === codecRank(prev.vcodec) && (f.tbr||0) > (prev.tbr||0)))
        map[h] = f;
    }
    return map;
  };

  const bestByHeightAV1   = buildBestByHeight(videoFormats);
  const bestByHeightNoAV1 = buildBestByHeight(videoFormats.filter(f => !f.vcodec.startsWith("av01")));

  const heights   = Object.keys(bestByHeightAV1).map(Number).sort((a,b) => a - b);
  const maxHeight = heights.length ? Math.max(...heights) : null;
  const bestFmtAV1   = maxHeight ? bestByHeightAV1[maxHeight]   : null;
  const bestFmtNoAV1 = maxHeight ? bestByHeightNoAV1[maxHeight] : null;

  const sizeByHeight = {};
  for (const [h, f] of Object.entries(bestByHeightAV1)) {
    const size = f.filesize || f.filesize_approx ||
      (f.tbr && duration ? Math.round((f.tbr * 1000 / 8) * duration) : null);
    if (size) sizeByHeight[Number(h)] = size;
  }

  const h264Heights = [...new Set(
    formats.filter(f => f.height && (f.vcodec||"").startsWith("avc1")).map(f => f.height)
  )].sort((a,b) => a - b);

  const codecByHeight = {};
  for (const h of heights) {
    const f = bestByHeightNoAV1[h];
    codecByHeight[h] = f ? codecLabel(f.vcodec) : "H.264";
  }

  return res.json({
    ok: true, platform: "youtube", degraded: false,
    title: info.title || null, thumbnail: info.thumbnail || null,
    maxHeight,
    bestCodecAV1: bestFmtAV1   ? codecLabel(bestFmtAV1.vcodec)   : "H.264",
    bestCodec:    bestFmtNoAV1 ? codecLabel(bestFmtNoAV1.vcodec) : "H.264",
    codec:        bestFmtNoAV1 ? codecLabel(bestFmtNoAV1.vcodec) : "H.264",
    codecByHeight, availableHeights: heights, h264Heights, sizeByHeight,
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