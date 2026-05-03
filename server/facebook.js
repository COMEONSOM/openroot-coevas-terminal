// ======================================================
// FACEBOOK DOWNLOADER — v9
//
// FIXES vs v8:
//   1. isRealFbVideo — broadened: ANY fbcdn/fbsbx .mp4
//      URL is accepted regardless of path-type segment.
//      Facebook post videos use many CDN path formats.
//
//   2. VIDEO WINS rule — when ANY video is found from
//      the HTML, images are COMPLETELY ignored (they are
//      always thumbnails/covers, never real content).
//
//   3. Story cookie validation — before running yt-dlp
//      we do a HEAD request to the story URL. If Facebook
//      redirects to login.php the cookies are expired and
//      we return a clear error immediately instead of
//      letting yt-dlp fail with a cryptic message.
//
//   4. yt-dlp fallback for video posts — if scrape finds
//      nothing useful, yt-dlp is always tried.
// ======================================================

import { spawn }  from "child_process";
import path       from "path";
import fs         from "fs";
import os         from "os";
import https      from "https";
import http       from "http";
import { sendLog } from "./utils/logStream.js";

/* ======================================================
   CONSTANTS
====================================================== */
const MIN_FILE_BYTES  = 10 * 1024;   // 10 KB — discard icons
const MAX_REDIRECTS   = 8;
const REQ_TIMEOUT_MS  = 30_000;

// Real photo path-type segments
const PHOTO_PATH_TYPES = ["/t39.30808-6/", "/t45.5405-15/"];

// Thumbnail / icon path-type segments — always skip for images
const SKIP_IMG_TYPES = [
  "/t39.30808-15/",  // video thumbnail
  "/t15.5256-4/",    // small preview
  "/t1.6435-",       // profile pic
  "/t31.0-",         // cover photo
  "/t50.", "/t51.",  // story thumbnails
];

const TINY_DIM_RE  = /[_/][sqp]\d{1,3}x\d{1,3}[_/.]/i;
const REAL_FNAME_RE = /\d{5,}_\d{5,}/;

const VIDEO_FIELDS = [
  "playable_url_quality_hd","playable_url","playable_url_dash",
  "hd_src","sd_src","hd_src_no_ratelimit","sd_src_no_ratelimit",
  "browser_native_hd_url","browser_native_sd_url",
  "video_url","src_hd","src_sd","progressive_url",
];
const IMAGE_FIELDS = [
  "display_url","uri","image_url","large_share_image","src","url",
];

const VIDEO_EXTS = ["mp4","mkv","mov","webm","m4v"];
const IMAGE_EXTS = ["jpg","jpeg","png","webp"];
const ALL_EXTS   = [...VIDEO_EXTS,...IMAGE_EXTS];

/* ======================================================
   HELPERS
====================================================== */
function todayStr()    { return new Date().toISOString().slice(0,10); }
function getPython()   { return process.platform==="win32"?"py":(process.env.PYTHON_BIN||"python3"); }
function safeCleanup(d){ try { fs.rm(d,{recursive:true,force:true},()=>{}); } catch {} }

function safeName(v) {
  return String(v||"unknown")
    .replace(/^@/,"").replace(/[^a-z0-9._-]+/gi,"_")
    .replace(/_+/g,"_").replace(/^_|_$/g,"").trim()||"unknown";
}

function buildFileName(username, ext, { index=null, type=null }={}) {
  const suffix = index!==null&&type!==null ? `_${type}${index}` : "";
  return `${safeName(username)}_facebook_${todayStr()}${suffix}.${ext}`;
}

function unesc(str) {
  return String(str||"")
    .replace(/\\\//g,"/").replace(/\\u0026/g,"&")
    .replace(/\\u003C/g,"<").replace(/\\u003E/g,">")
    .replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"');
}

function looksLikeAuthFailure(text="") {
  const t = String(text).toLowerCase();
  return t.includes("only available for registered users") ||
         t.includes("use --cookies") || t.includes("login required") ||
         t.includes("requires authentication") || t.includes("login.php") ||
         t.includes("private");
}

/* ======================================================
   STORY URL DETECTION
====================================================== */
function isFacebookStoryUrl(url) {
  try { return /\/stories(\/|$)/.test(new URL(url).pathname); }
  catch { return false; }
}

/* ======================================================
   CDN URL VALIDATORS
   ─────────────────────────────────────────────────────
   VIDEO: Accept ANY fbcdn/fbsbx .mp4 URL.
   Facebook post videos use many different CDN paths
   (t42, t44, t66, video.* hostname, scontent+mp4 etc.)
   Being strict here causes real videos to be missed.

   IMAGE: Only accept known real-photo path types.
   Reject thumbnails, profile pics, covers, tiny sizes.
====================================================== */
function isRealFbVideo(url) {
  if (!url?.startsWith("http")) return false;
  // Must be Facebook CDN
  if (!url.includes("fbcdn.net") && !url.includes("fbsbx.com")) return false;
  // Must be a video file
  if (!/\.mp4/i.test(url) && !/\.mov/i.test(url)) return false;
  // That's enough — any fbcdn .mp4 is a real video
  return true;
}

function isRealFbPhoto(url) {
  if (!url?.startsWith("http")) return false;
  if (!url.includes("fbcdn.net")) return false;
  // Static/UI CDN — never real photos
  if (url.includes("static.xx.fbcdn.net") || url.includes("static.fbcdn.net")) return false;
  // Must be user-uploaded content
  if (!url.includes("scontent")) return false;
  // Dimension marker → thumbnail
  if (TINY_DIM_RE.test(url)) return false;
  // Known skip types
  if (SKIP_IMG_TYPES.some(t => url.includes(t))) return false;
  // Must be a known real-photo path type
  if (!PHOTO_PATH_TYPES.some(t => url.includes(t))) return false;
  // Must have real media filename (not icon stub)
  try {
    const fn = new URL(url).pathname.split("/").pop()?.split("?")[0] || "";
    if (!REAL_FNAME_RE.test(fn)) return false;
  } catch { return false; }
  return true;
}

/* ======================================================
   MEDIA ID FROM CDN URL
====================================================== */
function mediaId(url) {
  try {
    const fn = new URL(url).pathname.split("/").pop() || "";
    return fn.match(/^(\d{5,}_\d{5,})/)?.[1] ?? null;
  } catch { return null; }
}

/* ======================================================
   HTTP GET with redirects
====================================================== */
function httpGet(url, hops=0) {
  if (hops > MAX_REDIRECTS) return Promise.reject(new Error("Too many redirects"));
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error("Invalid URL")); }
    const proto = parsed.protocol === "https:" ? https : http;
    const req = proto.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   "GET",
      headers: {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "Sec-Fetch-Dest":  "document",
        "Sec-Fetch-Mode":  "navigate",
        "Sec-Fetch-Site":  "none",
        "Cache-Control":   "no-cache",
      },
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return httpGet(new URL(res.headers.location, url).toString(), hops+1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => { body += c; });
      res.on("end",  () => resolve(body));
    });
    req.on("error", reject);
    req.setTimeout(REQ_TIMEOUT_MS, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

/* ======================================================
   STORY COOKIE VALIDATION
   ─────────────────────────────────────────────────────
   Do a lightweight HEAD-like GET (abort after headers)
   to check if Facebook redirects the story URL to
   login.php. If yes → cookies are expired/invalid.
====================================================== */
function checkStoryAccessible(storyUrl, cookieContent) {
  return new Promise(resolve => {
    // We can't send cookies in httpGet (no cookie header support there)
    // So we check: does a fresh request get redirected to login.php?
    // If yt-dlp's cookies can't prevent that, we want to warn the user.
    let parsed;
    try { parsed = new URL(storyUrl); } catch { return resolve("invalid_url"); }

    const proto = parsed.protocol === "https:" ? https : http;
    const req = proto.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   "GET",
      headers: {
        "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept":       "text/html,application/xhtml+xml",
        "Cache-Control":"no-cache",
        // Include cookies from cookie file if available
        ...(cookieContent ? { "Cookie": cookieContent } : {}),
      },
    }, res => {
      const finalUrl = res.headers.location || "";
      // If it redirects to login.php, cookies are no good
      if ([301,302,303].includes(res.statusCode) && finalUrl.includes("login.php")) {
        res.resume(); return resolve("login_redirect");
      }
      res.resume(); return resolve("ok");
    });
    req.on("error", () => resolve("error"));
    req.setTimeout(8000, () => { req.destroy(); resolve("timeout"); });
    req.end();
  });
}

/* ======================================================
   PARSE NETSCAPE COOKIES → Cookie header string
====================================================== */
function parseCookiesToHeader(cookiePath) {
  try {
    const lines = fs.readFileSync(cookiePath, "utf8").split("\n");
    return lines
      .filter(l => !l.startsWith("#") && l.includes("\t"))
      .map(l => {
        const parts = l.trim().split("\t");
        if (parts.length >= 7) return `${parts[5]}=${parts[6]}`;
        return null;
      })
      .filter(Boolean)
      .join("; ") || null;
  } catch { return null; }
}

/* ======================================================
   USERNAME EXTRACTION
====================================================== */
function extractCanonical(html, fallback) {
  const m = html.match(/property=["']og:url["'][^>]+content=["']([^"']+)["']/i)
         || html.match(/content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
  return m ? unesc(m[1]) : fallback;
}

function extractUsername(url, html) {
  const pathMatch = url.match(/facebook\.com\/([^/?#]+)\/(posts|videos|photos|reels)\//i)?.[1];
  if (pathMatch) {
    const blocked = ["share","watch","groups","events","pages","photo.php","permalink.php"];
    if (!blocked.includes(String(pathMatch).toLowerCase())) return safeName(pathMatch);
  }
  const storyUser = url.match(/facebook\.com\/([^/?#]+)\/stories/i)?.[1];
  if (storyUser) {
    const blocked = ["stories","watch","events","share"];
    if (!blocked.includes(String(storyUser).toLowerCase())) return safeName(storyUser);
  }
  if (html) {
    const ogTitle = html.match(/property=["']og:title["'][^>]+content=["']([^"']{1,120})["']/i)?.[1]
                 || html.match(/content=["']([^"']{1,120})["'][^>]+property=["']og:title["']/i)?.[1];
    if (ogTitle) {
      const m = ogTitle.match(/^([^|•–\-]+)/);
      if (m) return safeName(m[1].trim());
    }
    const actorMatch = html.match(/"actorName"\s*:\s*"([^"]{2,80})"/i)
                    || html.match(/"author"\s*:\s*"([^"]{2,80})"/i)
                    || html.match(/"page_name"\s*:\s*"([^"]{2,80})"/i);
    if (actorMatch) return safeName(actorMatch[1]);
  }
  const numericId = url.match(/\/(\d{8,})/)?.[1];
  if (numericId) return `fb_${numericId}`;
  return "unknown";
}

/* ======================================================
   EXTRACT MEDIA FROM PAGE HTML
   ─────────────────────────────────────────────────────
   KEY RULE: if ANY video is found, images are discarded.
   Images co-located with a video in the HTML are always
   thumbnails/covers — never real downloadable content.
====================================================== */
function extractMedia(html) {
  const videoSet = new Set();
  const imageSet = new Set();

  const addV = raw => { const u = unesc(raw); if (isRealFbVideo(u)) videoSet.add(u); };
  const addI = raw => { const u = unesc(raw); if (isRealFbPhoto(u)) imageSet.add(u); };

  // A. Named video fields
  for (const field of VIDEO_FIELDS) {
    const re = new RegExp(`["']${field}["']\\s*:\\s*["'](https?[^"'\\s]{10,900})["']`,"g");
    for (const m of html.matchAll(re)) addV(m[1]);
  }

  // B. Named image fields (fbcdn.net only)
  for (const field of IMAGE_FIELDS) {
    const re = new RegExp(`["']${field}["']\\s*:\\s*["'](https?[^"'\\s]{10,900}fbcdn\\.net[^"'\\s]{0,600})["']`,"g");
    for (const m of html.matchAll(re)) addI(m[1]);
  }

  // C. Raw scontent image sweep (real photo types only)
  for (const m of html.matchAll(
    /(https?:(?:\\\/\\\/|\/\/)[^\s"'`<>\\,]{5,}scontent[^\s"'`<>\\,]{0,60}fbcdn\.net\/v\/t39\.30808-6\/[^\s"'`<>\\,]{10,500}\.(?:jpg|jpeg|png|webp)[^\s"'`<>\\,]{0,300})/g
  )) addI(m[1]);

  for (const m of html.matchAll(
    /(https?:(?:\\\/\\\/|\/\/)[^\s"'`<>\\,]{5,}scontent[^\s"'`<>\\,]{0,60}fbcdn\.net\/v\/t45\.[^\s"'`<>\\,]{10,500}\.(?:jpg|jpeg|png|webp)[^\s"'`<>\\,]{0,300})/g
  )) addI(m[1]);

  // D. Raw video CDN sweep — broad, catches all fbcdn/fbsbx mp4
  for (const m of html.matchAll(
    /(https?:(?:\\\/\\\/|\/\/)[^\s"'`<>\\,]{5,}(?:fbcdn|fbsbx)\.net[^\s"'`<>\\,]{0,800}\.mp4[^\s"'`<>\\,]{0,300})/g
  )) addV(m[1]);

  // E. og:video fallback
  if (videoSet.size === 0) {
    for (const m of [
      ...html.matchAll(/property=["']og:video["'][^>]+content=["']([^"']+)["']/gi),
      ...html.matchAll(/content=["']([^"']+)["'][^>]+property=["']og:video["']/gi),
    ]) addV(m[1]);
  }

  // F. og:image — ONLY if absolutely nothing else was found
  if (imageSet.size === 0 && videoSet.size === 0) {
    for (const m of [
      ...html.matchAll(/property=["']og:image["'][^>]+content=["']([^"']+)["']/gi),
      ...html.matchAll(/content=["']([^"']+)["'][^>]+property=["']og:image["']/gi),
    ]) { const u = unesc(m[1]); if (u.startsWith("http")) imageSet.add(u); }
  }

  // Dedup
  function dedup(urls) {
    const seenPath = new Set(), seenId = new Set();
    return [...urls].filter(u => {
      try {
        const key = new URL(u).pathname;
        const id  = mediaId(u);
        if (seenPath.has(key)) return false;
        if (id && seenId.has(id)) return false;
        seenPath.add(key);
        if (id) seenId.add(id);
        return true;
      } catch { return false; }
    });
  }

  function pickBestVideos(urls) {
    const byId = new Map();
    for (const u of urls) {
      const id = mediaId(u) || u;
      if (!byId.has(id) || u.length > byId.get(id).length) byId.set(id, u);
    }
    return [...byId.values()];
  }

  const finalVideos = dedup(pickBestVideos([...videoSet]));

  // ── KEY RULE: if videos found, discard ALL images ──────
  // Images found alongside video URLs are always thumbnails.
  // A post cannot have both real videos AND real standalone
  // photos at the same time from the scraper's perspective.
  if (finalVideos.length > 0) {
    console.log(`[facebook v9] ${finalVideos.length} video(s) found — ignoring ${imageSet.size} image URL(s) (thumbnails)`);
    return { videos: finalVideos, images: [] };
  }

  const videoIds   = new Set(finalVideos.map(mediaId).filter(Boolean));
  const finalImages = dedup([...imageSet]).filter(img => {
    const id = mediaId(img);
    if (id && videoIds.has(id)) return false;
    if (img.includes("/t39.30808-15/")) return false;
    return true;
  });

  console.log(`[facebook v9] extract: ${finalVideos.length}v ${finalImages.length}i`);
  return { videos: finalVideos, images: finalImages };
}

/* ======================================================
   STREAM SINGLE URL → BROWSER
====================================================== */
function streamFile(fileUrl, fileName, mimeType, res, app, onDone, hops=0) {
  if (hops > 5) {
    if (!res.headersSent) res.status(500).json({ ok:false, error:"Too many redirects" });
    return onDone();
  }
  let parsed;
  try { parsed = new URL(fileUrl); }
  catch { if (!res.headersSent) res.status(500).json({ ok:false, error:"Invalid URL" }); return onDone(); }

  const proto = parsed.protocol === "https:" ? https : http;
  const req = proto.request({
    hostname: parsed.hostname,
    path:     parsed.pathname + parsed.search,
    method:   "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer":    "https://www.facebook.com/",
    },
  }, remoteRes => {
    if ([301,302,303,307,308].includes(remoteRes.statusCode) && remoteRes.headers.location)
      return streamFile(new URL(remoteRes.headers.location, fileUrl).toString(), fileName, mimeType, res, app, onDone, hops+1);
    if (remoteRes.statusCode !== 200) {
      if (!res.headersSent) res.status(500).json({ ok:false, error:`HTTP ${remoteRes.statusCode}` });
      return onDone();
    }
    const cl = remoteRes.headers["content-length"] || "";
    res.setHeader("Content-Type",        remoteRes.headers["content-type"] || mimeType);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    if (cl) res.setHeader("Content-Length", cl);
    res.setHeader("Cache-Control", "no-store");

    let downloaded = 0, total = parseInt(cl,10) || 0;
    remoteRes.on("data", chunk => {
      downloaded += chunk.length;
      if (total > 0 && app.locals.progressRes && !app.locals.progressRes.writableEnded) {
        app.locals.progressRes.write(`data: ${Math.round(downloaded/total*100)}\n\n`);
        app.locals.progressRes.flush?.();
      }
    });
    remoteRes.pipe(res);
    remoteRes.on("end",   () => { sendLog(app, `Streamed: ${fileName}`); onDone(); });
    remoteRes.on("error", e  => { sendLog(app, `Stream error: ${e.message}`); res.destroy(); onDone(); });
  });
  req.on("error", e => { if (!res.headersSent) res.status(500).json({ ok:false, error:e.message }); onDone(); });
  req.setTimeout(REQ_TIMEOUT_MS, () => { req.destroy(); if (!res.headersSent) res.status(500).json({ ok:false, error:"Timeout" }); onDone(); });
  req.end();
}

/* ======================================================
   SAVE URL → DISK
====================================================== */
function saveToDisk(fileUrl, outPath, onDone, hops=0) {
  if (hops > 5) return onDone(null, new Error("Too many redirects"));
  let parsed;
  try { parsed = new URL(fileUrl); } catch(e) { return onDone(null, e); }

  const proto = parsed.protocol === "https:" ? https : http;
  const req = proto.request({
    hostname: parsed.hostname,
    path:     parsed.pathname + parsed.search,
    method:   "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer":    "https://www.facebook.com/",
    },
  }, remoteRes => {
    if ([301,302,303,307,308].includes(remoteRes.statusCode) && remoteRes.headers.location)
      return saveToDisk(new URL(remoteRes.headers.location, fileUrl).toString(), outPath, onDone, hops+1);
    if (remoteRes.statusCode !== 200) return onDone(null, new Error(`HTTP ${remoteRes.statusCode}`));
    const stream = fs.createWriteStream(outPath);
    remoteRes.pipe(stream);
    stream.on("finish", () => onDone(outPath));
    stream.on("error",  e  => onDone(null, e));
  });
  req.on("error", e => onDone(null, e));
  req.setTimeout(REQ_TIMEOUT_MS, () => { req.destroy(); onDone(null, new Error("Timeout")); });
  req.end();
}

/* ======================================================
   SAVE BATCH with 10KB size filter
====================================================== */
async function saveBatch(items, tempDir, app) {
  const saved = [];
  for (const item of items) {
    if (app.locals.cancelRequested) { sendLog(app, "Canceled"); break; }
    const outPath = path.join(tempDir, item.fileName);
    sendLog(app, `⬇ ${item.fileName}`);
    await new Promise(resolve => {
      saveToDisk(item.url, outPath, (savedPath, err) => {
        if (err) {
          sendLog(app, `  ✗ ${item.fileName}: ${err.message}`);
        } else if (savedPath) {
          try {
            const size = fs.statSync(savedPath).size;
            if (size >= MIN_FILE_BYTES) {
              saved.push(savedPath);
              sendLog(app, `  ✓ ${item.fileName} (${Math.round(size/1024)}KB)`);
            } else {
              sendLog(app, `  ✗ ${item.fileName}: ${size}B < 10KB — discarded`);
              try { fs.unlinkSync(savedPath); } catch {}
            }
          } catch {}
        }
        resolve();
      });
    });
  }
  return saved;
}

/* ======================================================
   CREATE ZIP
====================================================== */
async function createZip(files, zipPath) {
  try {
    const archiver = (await import("archiver")).default;
    await new Promise((resolve, reject) => {
      const output  = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib:{ level:0 } });
      output.on("close", resolve); output.on("error", reject);
      archive.on("error", reject); archive.pipe(output);
      for (const f of files) archive.file(f, { name: path.basename(f) });
      archive.finalize();
    });
    return zipPath;
  } catch {}

  if (process.platform === "win32") {
    const list = files.map(f => `'${String(f).replace(/'/g,"''")}'`).join(", ");
    const dest = String(zipPath).replace(/'/g,"''");
    await new Promise((resolve, reject) => {
      const proc = spawn("powershell", [
        "-NoProfile","-NonInteractive","-Command",
        `Compress-Archive -LiteralPath @(${list}) -DestinationPath '${dest}' -Force`,
      ], { shell:false, windowsHide:true });
      let stderr = "";
      proc.stderr.on("data", d => { stderr += d; });
      proc.on("error", reject);
      proc.on("close", code => code===0 ? resolve() : reject(new Error(stderr||`PS exit ${code}`)));
    });
    return zipPath;
  }

  await new Promise((resolve, reject) => {
    const proc = spawn("zip", ["-j", zipPath, ...files], { shell:false });
    proc.on("error", reject);
    proc.on("close", code => code===0 ? resolve() : reject(new Error(`zip exit ${code}`)));
  });
  return zipPath;
}

/* ======================================================
   STREAM ZIP → BROWSER
====================================================== */
async function streamZip(files, zipName, res, app, onDone) {
  const zipPath = path.join(path.dirname(files[0]), zipName);
  try { await createZip(files, zipPath); }
  catch(err) {
    sendLog(app, `ZIP creation failed: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ ok:false, error:"ZIP creation failed" });
    return onDone();
  }
  const stat = fs.statSync(zipPath);
  res.setHeader("Content-Type",        "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
  res.setHeader("Content-Length",      stat.size);
  res.setHeader("Cache-Control",       "no-store");
  const rs = fs.createReadStream(zipPath);
  rs.pipe(res);
  rs.on("end",   () => { sendLog(app, `ZIP sent: ${zipName}`); onDone(); });
  rs.on("error", e  => { sendLog(app, `ZIP stream error: ${e.message}`); res.destroy(); onDone(); });
}

/* ======================================================
   CLOSE SSE
====================================================== */
function closeSSE(app) {
  if (app.locals.progressRes && !app.locals.progressRes.writableEnded) {
    app.locals.progressRes.write("data: 100\n\n");
    app.locals.progressRes.flush?.();
    app.locals.progressRes.end();
    app.locals.progressRes = null;
  }
  if (app.locals.logRes && !app.locals.logRes.writableEnded) {
    app.locals.logRes.end();
    app.locals.logRes = null;
  }
}

/* ======================================================
   YT-DLP RUNNER
   --cookies placed BEFORE URL (critical for auth)
====================================================== */
function runYtDlp({ canonicalUrl, tempDir, cookiesPath, app }) {
  return new Promise(resolve => {
    const outTpl = path.join(tempDir, "%(uploader)s_facebook_%(id)s.%(ext)s");
    const args = [
      "-3","-m","yt_dlp",
      "--no-playlist","--restrict-filenames",
      "--newline","--no-warnings",
      "--retries","3",
      "--user-agent","Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "--add-header","Referer:https://www.facebook.com/",
      "-o", outTpl,
    ];

    // --cookies BEFORE URL
    if (cookiesPath && fs.existsSync(cookiesPath)) {
      args.push("--cookies", cookiesPath);
      sendLog(app, `yt-dlp: using cookies file`);
    } else {
      sendLog(app, "yt-dlp: no cookies file");
    }

    args.push("-f", "bv*+ba/best", "--merge-output-format", "mp4");
    args.push(canonicalUrl); // URL always last

    sendLog(app, `yt-dlp fallback: ${canonicalUrl}`);
    const proc = spawn(getPython(), args, { shell:false, windowsHide:true });
    app.locals.currentProc = proc;
    let stderr = "";
    proc.stdout.on("data", d => {
      const t = d.toString(); sendLog(app, t);
      const m = t.match(/(\d{1,3}(?:\.\d+)?)%/);
      if (m && app.locals.progressRes && !app.locals.progressRes.writableEnded)
        app.locals.progressRes.write(`data: ${m[1]}\n\n`);
    });
    proc.stderr.on("data", d => { stderr += d; sendLog(app, `yt-dlp: ${d}`); });
    proc.on("error", e => { app.locals.currentProc=null; resolve({ ok:false, stderr:e.message }); });
    proc.on("close", code => { app.locals.currentProc=null; resolve({ ok:code===0, stderr }); });
  });
}

/* ======================================================
   COLLECT FILES FROM TEMP DIR
====================================================== */
function collectFiles(dir, exts) {
  const extSet = new Set(exts);
  const out = [];
  const walk = d => {
    try {
      for (const e of fs.readdirSync(d, { withFileTypes:true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (extSet.has(path.extname(e.name).slice(1).toLowerCase())) out.push(full);
      }
    } catch {}
  };
  walk(dir); return out;
}

/* ======================================================
   DELIVER FILES (single stream or ZIP)
====================================================== */
async function deliverFiles(savedFiles, username, label, res, app, cleanup) {
  if (savedFiles.length === 0) return false;

  if (savedFiles.length === 1) {
    const f   = savedFiles[0];
    const ext = path.extname(f).slice(1).toLowerCase() || "mp4";
    const mime = ext==="mp4"?"video/mp4":ext==="png"?"image/png":ext==="webp"?"image/webp":"image/jpeg";
    const fileName = buildFileName(username, ext);
    sendLog(app, `→ Single ${ext}: ${fileName}`);
    closeSSE(app);
    return new Promise(resolve => {
      res.download(f, fileName, err => { if (err) console.warn(err.message); cleanup(); resolve(true); });
    });
  }

  // Multiple → rename → ZIP
  const renamed = [];
  let vidIdx = 1, imgIdx = 1;
  for (const f of savedFiles) {
    const ext  = path.extname(f).slice(1).toLowerCase() || "jpg";
    const type = VIDEO_EXTS.includes(ext) ? "vid" : "img";
    const idx  = type === "vid" ? vidIdx++ : imgIdx++;
    const newName = buildFileName(username, ext, { index:idx, type });
    const newPath = path.join(path.dirname(f), newName);
    try { fs.renameSync(f, newPath); renamed.push(newPath); } catch { renamed.push(f); }
  }

  const zipName = `${safeName(username)}_facebook_${todayStr()}.zip`;
  sendLog(app, `Zipping ${renamed.length} files → ${zipName}`);
  closeSSE(app);
  await streamZip(renamed, zipName, res, app, cleanup);
  return true;
}

/* ======================================================
   MAIN EXPORT
====================================================== */
export async function downloadFacebook({ url, mode="video" }, res, app, cookiesPath) {
  app.locals.cancelRequested = false;
  sendLog(app, "Facebook v9: starting…");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
  const cleanup = () => safeCleanup(tempDir);

  try {

    // ── Stage 0: Story detection ──────────────────────────
    if (isFacebookStoryUrl(url)) {
      sendLog(app, "Story URL detected");

      if (!cookiesPath || !fs.existsSync(cookiesPath)) {
        sendLog(app, "ERROR: No cookies.txt — stories require Facebook login");
        closeSSE(app); cleanup();
        return res.status(500).json({
          ok: false, error: "STORIES_LOGIN_REQUIRED",
          details: "Facebook Stories require login. Export Netscape cookies.txt from Chrome/Edge while logged in to Facebook, then import it in Settings.",
        });
      }

      // Validate cookies by checking if story URL is accessible
      const cookieHeader = parseCookiesToHeader(cookiesPath);
      sendLog(app, "Checking if story is accessible with current cookies…");
      const accessStatus = await checkStoryAccessible(url, cookieHeader);

      if (accessStatus === "login_redirect") {
        sendLog(app, "ERROR: Facebook cookies are expired — story redirects to login.php");
        closeSSE(app); cleanup();
        return res.status(500).json({
          ok: false, error: "STORIES_COOKIES_EXPIRED",
          details: "Your Facebook cookies have expired. Please export a fresh Netscape cookies.txt from Chrome/Edge while logged in to Facebook, then re-import it in Settings.",
        });
      }

      const username = extractUsername(url, "");
      sendLog(app, `Story author: ${username}`);

      const ytResult = await runYtDlp({ canonicalUrl:url, tempDir, cookiesPath, app });
      const storyFiles = collectFiles(tempDir, ALL_EXTS);

      if (storyFiles.length === 0) {
        closeSSE(app); cleanup();
        const isAuth = looksLikeAuthFailure(ytResult.stderr);
        return res.status(500).json({
          ok: false, error: "STORY_DOWNLOAD_FAILED",
          details: isAuth
            ? "Story is private or cookies expired. Re-export fresh cookies.txt from a logged-in browser."
            : "Story unavailable — it may have expired (stories last 24h) or be private.",
        });
      }

      const done = await deliverFiles(storyFiles, username, "story", res, app, cleanup);
      if (!done) { closeSSE(app); cleanup(); res.status(500).json({ ok:false, error:"STORY_EMPTY" }); }
      return;
    }

    // ── Stage 1: Fetch HTML ───────────────────────────────
    let html = "", canonicalUrl = url;
    try {
      sendLog(app, "Fetching page HTML…");
      html = await httpGet(url);
      sendLog(app, `Page fetched: ${Math.round(html.length/1024)} KB`);
      canonicalUrl = extractCanonical(html, url);
      sendLog(app, `Canonical: ${canonicalUrl}`);
    } catch(err) {
      sendLog(app, `Page fetch failed: ${err.message}`);
    }

    // Re-check canonical for story
    if (isFacebookStoryUrl(canonicalUrl)) {
      sendLog(app, "Canonical is a story URL — routing to story handler");
      const username = extractUsername(canonicalUrl, html);
      if (!cookiesPath || !fs.existsSync(cookiesPath)) {
        closeSSE(app); cleanup();
        return res.status(500).json({
          ok: false, error: "STORIES_LOGIN_REQUIRED",
          details: "Facebook Stories require login. Export Netscape cookies.txt from a logged-in browser.",
        });
      }
      const ytResult = await runYtDlp({ canonicalUrl, tempDir, cookiesPath, app });
      const storyFiles = collectFiles(tempDir, ALL_EXTS);
      if (storyFiles.length === 0) {
        closeSSE(app); cleanup();
        return res.status(500).json({ ok:false, error:"STORY_DOWNLOAD_FAILED", details:"Story unavailable or cookies expired." });
      }
      const done = await deliverFiles(storyFiles, username, "story", res, app, cleanup);
      if (!done) { closeSSE(app); cleanup(); res.status(500).json({ ok:false, error:"STORY_EMPTY" }); }
      return;
    }

    const username = extractUsername(canonicalUrl, html);
    sendLog(app, `Author: ${username}`);

    // ── Stage 2: Extract media ────────────────────────────
    const { videos, images } = html ? extractMedia(html) : { videos:[], images:[] };
    sendLog(app, `Extracted: ${videos.length} video(s), ${images.length} image(s)`);

    // ── Stage 3: Route by what we found ──────────────────

    // Videos found (1 or more) — images already discarded by extractMedia
    if (videos.length === 1) {
      const fileName = buildFileName(username, "mp4");
      sendLog(app, `→ Single video: ${fileName}`);
      closeSSE(app);
      return streamFile(videos[0], fileName, "video/mp4", res, app, cleanup);
    }

    if (videos.length > 1) {
      sendLog(app, `→ ${videos.length} videos`);
      const items = videos.map((u,i) => ({
        url: u, fileName: buildFileName(username, "mp4", { index:i+1, type:"vid" }),
      }));
      const saved = await saveBatch(items, tempDir, app);
      const done  = await deliverFiles(saved, username, "videos", res, app, cleanup);
      if (done) return;
    }

    // Only images
    if (images.length === 1) {
      const ext  = images[0].includes(".png")?"png":images[0].includes(".webp")?"webp":"jpg";
      const mime = ext==="png"?"image/png":ext==="webp"?"image/webp":"image/jpeg";
      const fileName = buildFileName(username, ext);
      sendLog(app, `→ Single image: ${fileName}`);
      closeSSE(app);
      return streamFile(images[0], fileName, mime, res, app, cleanup);
    }

    if (images.length > 1) {
      sendLog(app, `→ Image album: ${images.length} images`);
      const items = images.map((u,i) => {
        const ext = u.includes(".png")?"png":u.includes(".webp")?"webp":"jpg";
        return { url:u, fileName:buildFileName(username, ext, { index:i+1, type:"img" }) };
      });
      const saved = await saveBatch(items, tempDir, app);
      const done  = await deliverFiles(saved, username, "album", res, app, cleanup);
      if (done) return;
    }

    // ── Stage 4: yt-dlp fallback ──────────────────────────
    // Runs when scrape found nothing OR all downloads failed
    sendLog(app, "Scrape insufficient — yt-dlp fallback…");
    const ytResult = await runYtDlp({ canonicalUrl, tempDir, cookiesPath, app });
    const ytFiles  = collectFiles(tempDir, ALL_EXTS);

    if (ytFiles.length > 0) {
      const done = await deliverFiles(ytFiles, username, "media", res, app, cleanup);
      if (done) return;
    }

    // ── Stage 5: All failed ───────────────────────────────
    closeSSE(app); cleanup();
    const isPrivate = looksLikeAuthFailure(String(ytResult?.stderr || ""));
    sendLog(app, isPrivate
      ? "Private post — export fresh cookies.txt from a logged-in browser"
      : "All extraction methods failed"
    );
    return res.status(500).json({
      ok: false, error: "FACEBOOK_DOWNLOAD_FAILED",
      details: isPrivate
        ? "This post requires login. Export Netscape cookies.txt from Chrome/Edge while logged in to Facebook and import it in Settings."
        : "No media found. The post may be private, deleted, or this post type is not yet supported.",
    });

  } catch(err) {
    app.locals.currentProc = null;
    closeSSE(app); cleanup();
    console.error("Facebook v9 exception:", err);
    sendLog(app, `Exception: ${err.message}`);
    return res.status(500).json({ ok:false, error:"FACEBOOK_DOWNLOAD_FAILED", details:err.message });
  }
}