// ======================================================
// THREADS DOWNLOADER — v16
// Single file  → stream directly
// Multiple     → save all → ZIP → stream as one download
// ======================================================

import path  from "path";
import fs    from "fs";
import os    from "os";
import https from "https";
import http  from "http";
import { spawn } from "child_process";
import { sendLog } from "./utils/logStream.js";

/* ======================================================
   FILE NAMING
====================================================== */
function todayStr() { return new Date().toISOString().slice(0, 10); }

function safeName(v) {
  return String(v || "unknown")
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .trim() || "unknown";
}

function buildFileName(username, ext, { index = null, type = null } = {}) {
  const suffix = (index !== null && type !== null) ? `_${type}${index}` : "";
  return `${safeName(username)}_threads_${todayStr()}${suffix}.${ext}`;
}

/* ======================================================
   FETCH PAGE HTML
====================================================== */
function fetchPage(pageUrl, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error("Too many redirects"));
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(pageUrl); }
    catch { return reject(new Error("Invalid URL")); }

    const proto = parsed.protocol === "https:" ? https : http;
    const req = proto.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   "GET",
      headers: {
        "User-Agent":                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language":           "en-US,en;q=0.9",
        "Accept-Encoding":           "identity",
        "Cache-Control":             "no-cache",
        "Pragma":                    "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest":            "document",
        "Sec-Fetch-Mode":            "navigate",
        "Sec-Fetch-Site":            "none",
        "Sec-Fetch-User":            "?1",
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : `https://${parsed.hostname}${res.headers.location}`;
        return fetchPage(next, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode} from Threads`));
      res.setEncoding("utf8");
      let html = "";
      res.on("data", c => { html += c; });
      res.on("end",  () => resolve(html));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Fetch timeout")); });
    req.end();
  });
}

/* ======================================================
   DECODE HTML ENTITIES
====================================================== */
function decodeHTML(str) {
  return String(str || "")
    .replace(/\\u0026/g, "&").replace(/\\u003C/g, "<")
    .replace(/\\u003E/g, ">").replace(/\\u002F/g, "/")
    .replace(/\\n/g,    "").replace(/&amp;/g,    "&")
    .replace(/&lt;/g,   "<").replace(/&gt;/g,    ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g,   "'");
}

/* ======================================================
   URL HELPERS
====================================================== */
function extractPostCode(url) {
  try { return url.match(/\/post\/([^/?#]+)/i)?.[1] ?? null; }
  catch { return null; }
}

function extractUsernameFromUrl(url) {
  try {
    const m = url.match(/threads\.(?:net|com)\/@([^/]+)\//i);
    return m ? decodeURIComponent(m[1]).replace(/^@/, "") : null;
  } catch { return null; }
}

/* ======================================================
   SHORTCODE → NUMERIC PK
====================================================== */
function shortcodeToId(code) {
  if (!code || typeof code !== "string") return null;
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  try {
    let n = 0n;
    for (const c of code) {
      const idx = alpha.indexOf(c);
      if (idx === -1) return null;
      n = n * 64n + BigInt(idx);
    }
    return n.toString();
  } catch { return null; }
}

/* ======================================================
   IMAGE URL FILTER
====================================================== */
function isValidImageUrl(url) {
  if (!url || typeof url !== "string" || !url.startsWith("http")) return false;
  const block = [
    "profile_pic","s150x150","s320x320","s640x640",
    "_s.jpg","emoji","rsrc.php","static.cdninstagram",
    "instagram.com/static",".gif","stories","highlight",
  ];
  return !block.some(b => url.includes(b));
}

/* ======================================================
   PICK BEST CANDIDATE
====================================================== */
function bestCandidate(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  let best = null, bestW = -1;
  for (const c of candidates) {
    if (c?.url?.startsWith?.("http")) {
      const w = typeof c.width === "number" ? c.width : 0;
      if (w > bestW || !best) { bestW = w; best = c.url; }
    }
  }
  return best;
}

function imageFromV2(iv2) {
  if (!iv2 || typeof iv2 !== "object") return null;
  if (Array.isArray(iv2.candidates)) return bestCandidate(iv2.candidates);
  if (Array.isArray(iv2)) return bestCandidate(iv2);
  return null;
}

function hasMedia(node) {
  if (!node || typeof node !== "object") return false;
  return !!(
    (Array.isArray(node.carousel_media)  && node.carousel_media.length) ||
    (Array.isArray(node.video_versions)  && node.video_versions.length) ||
    (typeof node.video_url === "string"  && node.video_url.includes(".mp4")) ||
    node.image_versions2
  );
}

/* ======================================================
   EXTRACT MEDIA FROM EXACTLY ONE POST NODE
====================================================== */
function extractFromNode(node) {
  const videos = [], images = [];
  if (!node || typeof node !== "object") return { videos, images };

  if (Array.isArray(node.carousel_media) && node.carousel_media.length) {
    for (const item of node.carousel_media) {
      if (!item || typeof item !== "object") continue;
      if (Array.isArray(item.video_versions) && item.video_versions.length) {
        const url = bestCandidate(item.video_versions);
        if (url) { videos.push(url); continue; }
      }
      if (typeof item.video_url === "string" && item.video_url.includes(".mp4")) {
        videos.push(item.video_url); continue;
      }
      if (item.image_versions2) {
        const url = imageFromV2(item.image_versions2);
        if (url && isValidImageUrl(url)) images.push(url);
      }
    }
    return { videos, images };
  }

  if (Array.isArray(node.video_versions) && node.video_versions.length) {
    const url = bestCandidate(node.video_versions);
    if (url) return { videos: [url], images: [] };
  }
  if (typeof node.video_url === "string" && node.video_url.includes(".mp4"))
    return { videos: [node.video_url], images: [] };

  if (node.image_versions2) {
    const url = imageFromV2(node.image_versions2);
    if (url && isValidImageUrl(url)) images.push(url);
  }
  return { videos, images };
}

/* ======================================================
   GET AUTHOR FROM NODE
====================================================== */
function getAuthor(node) {
  if (!node || typeof node !== "object") return null;
  const u = node?.user?.username ?? node?.owner?.username ?? node?.author?.username ?? node?.username ?? null;
  return typeof u === "string" && u.trim() ? u.trim().replace(/^@/, "") : null;
}

/* ======================================================
   DEDUPLICATE
====================================================== */
function deduplicate(urls) {
  const seen = new Set();
  return urls.filter(u => { if (!u || seen.has(u)) return false; seen.add(u); return true; });
}

/* ======================================================
   DEEP SEARCH
====================================================== */
function deepSearch(obj, predicate, depth = 0, seen = new WeakSet()) {
  if (!obj || typeof obj !== "object" || depth > 60) return null;
  if (seen.has(obj)) return null;
  seen.add(obj);
  if (!Array.isArray(obj) && predicate(obj)) return obj;
  const children = Array.isArray(obj) ? obj : Object.values(obj);
  for (const child of children) {
    if (child && typeof child === "object") {
      const found = deepSearch(child, predicate, depth + 1, seen);
      if (found) return found;
    }
  }
  return null;
}

/* ======================================================
   KNOWN THREADS JSON PATHS
====================================================== */
const KNOWN_PATHS = [
  j => j?.props?.pageProps?.thread?.thread_items?.[0]?.post,
  j => j?.props?.pageProps?.thread?.containing_thread?.thread_items?.[0]?.post,
  j => j?.props?.pageProps?.threads?.[0]?.thread_items?.[0]?.post,
  j => j?.props?.pageProps?.post,
  j => j?.props?.pageProps?.data?.thread?.thread_items?.[0]?.post,
  j => j?.props?.pageProps?.data?.post,
  j => j?.data?.thread?.thread_items?.[0]?.post,
  j => j?.data?.post,
  j => j?.data?.data?.thread_items?.[0]?.post,
  j => j?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0],
  j => j?.data?.xdt_threads_thread_to_parent_post?.thread_items?.[0]?.post,
];

/* ======================================================
   SHALLOW BFS
====================================================== */
function shallowBFS(root) {
  if (!root || typeof root !== "object") return null;
  const queue = [{ obj: root, depth: 0 }];
  const seen  = new WeakSet();
  while (queue.length) {
    const { obj, depth } = queue.shift();
    if (!obj || typeof obj !== "object" || depth > 15) continue;
    if (seen.has(obj)) continue;
    seen.add(obj);
    if (!Array.isArray(obj) && hasMedia(obj)) return obj;
    const children = Array.isArray(obj) ? obj : Object.values(obj);
    for (const child of children)
      if (child && typeof child === "object") queue.push({ obj: child, depth: depth + 1 });
  }
  return null;
}

/* ======================================================
   FIND TARGET POST — 4-pass
====================================================== */
function findTargetPost(json, postCode) {
  const numericId = shortcodeToId(postCode);

  if (numericId) {
    const found = deepSearch(json, node =>
      (String(node.pk) === numericId || String(node.id) === numericId) && hasMedia(node)
    );
    if (found) { console.log("[threads] Post found: pk match"); return found; }
  }

  if (postCode) {
    const found = deepSearch(json, node =>
      (node.code === postCode || node.shortcode === postCode) && hasMedia(node)
    );
    if (found) { console.log("[threads] Post found: code match"); return found; }
  }

  for (const navFn of KNOWN_PATHS) {
    try {
      const candidate = navFn(json);
      if (candidate && hasMedia(candidate)) {
        console.log("[threads] Post found: known path"); return candidate;
      }
    } catch {}
  }

  const bfs = shallowBFS(json);
  if (bfs) { console.log("[threads] Post found: shallow BFS"); return bfs; }
  return null;
}

/* ======================================================
   CDN REGEX FALLBACK
====================================================== */
function regexFallback(html) {
  const videos = new Set(), images = new Set();
  for (const m of html.matchAll(/"(https?:\\?\/\\?\/[^"]*\.mp4[^"]{0,300})"/g)) {
    try {
      const url = decodeHTML(m[1].replace(/\\/g, ""));
      if (url.startsWith("http") && (url.includes("cdninstagram") || url.includes("fbcdn")))
        videos.add(url);
    } catch {}
  }
  for (const m of html.matchAll(/"(https?:\\?\/\\?\/[^"]*cdninstagram\.com[^"]{0,300})"/g)) {
    try {
      const url = decodeHTML(m[1].replace(/\\/g, ""));
      if (isValidImageUrl(url)) images.add(url);
    } catch {}
  }
  if (images.size === 0) {
    for (const m of [
      ...html.matchAll(/property="og:image"\s+content="([^"]+)"/gi),
      ...html.matchAll(/content="([^"]+)"\s+property="og:image"/gi),
    ]) { const url = decodeHTML(m[1]); if (isValidImageUrl(url)) images.add(url); }
  }
  return { videos: deduplicate([...videos]), images: deduplicate([...images]) };
}

/* ======================================================
   EXTRACT MEDIA FROM PAGE HTML
====================================================== */
function extractMedia(html, postCode) {
  let post = null, strategy = "none";

  const nextDataMatch =
    html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i) ||
    html.match(/<script[^>]+type=["']application\/json["'][^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);

  if (nextDataMatch) {
    try {
      const json = JSON.parse(nextDataMatch[1]);
      post = findTargetPost(json, postCode);
      if (post) strategy = "nextdata";
    } catch (e) { console.warn("[threads] __NEXT_DATA__ parse failed:", e.message); }
  }

  if (!post) {
    for (const sm of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
      const content = sm[1].trim();
      if (content.length < 200) continue;
      try {
        let json = null;
        if (content.startsWith("{") || content.startsWith("[")) json = JSON.parse(content);
        else {
          const a = content.match(/(?:self\.|window\.)?[\w$][\w$.]*\s*=\s*(\{[\s\S]{100,}?\})\s*;?\s*$/s);
          if (a) json = JSON.parse(a[1]);
        }
        if (json) { post = findTargetPost(json, postCode); if (post) { strategy = "script-blob"; break; } }
      } catch {}
    }
  }

  if (post) {
    const author = getAuthor(post);
    const result = extractFromNode(post);
    console.log(`[threads] Strategy: ${strategy} | Author: ${author ?? "?"} | ${result.videos.length}v ${result.images.length}i`);
    return { ...result, author, strategy };
  }

  console.warn("[threads] JSON failed — CDN regex fallback");
  const fallback = regexFallback(html);
  return { ...fallback, author: null, strategy: "regex" };
}

/* ======================================================
   CREATE ZIP
====================================================== */
async function createZip(files, zipPath) {
  try {
    const archiver = (await import("archiver")).default;
    await new Promise((resolve, reject) => {
      const output  = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 0 } });
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      for (const f of files) archive.file(f, { name: path.basename(f) });
      archive.finalize();
    });
    return zipPath;
  } catch {}

  // PowerShell fallback (Windows)
  if (process.platform === "win32") {
    const list = files.map(f => `'${String(f).replace(/'/g,"''")}'`).join(", ");
    const dest = String(zipPath).replace(/'/g, "''");
    await new Promise((resolve, reject) => {
      const proc = spawn("powershell", [
        "-NoProfile","-NonInteractive","-Command",
        `Compress-Archive -LiteralPath @(${list}) -DestinationPath '${dest}' -Force`,
      ], { shell: false, windowsHide: true });
      let stderr = "";
      proc.stderr.on("data", d => { stderr += d.toString(); });
      proc.on("error", reject);
      proc.on("close", code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `PS exit ${code}`)));
    });
    return zipPath;
  }

  // zip command (Unix)
  await new Promise((resolve, reject) => {
    const proc = spawn("zip", ["-j", zipPath, ...files], { shell: false });
    proc.on("error", reject);
    proc.on("close", code => code === 0 ? resolve() : reject(new Error(`zip exit ${code}`)));
  });
  return zipPath;
}

/* ======================================================
   STREAM ZIP → BROWSER
====================================================== */
async function streamZip(files, zipName, res, app, onDone) {
  const zipPath = path.join(path.dirname(files[0]), zipName);
  try {
    await createZip(files, zipPath);
  } catch (err) {
    sendLog(app, `ZIP creation failed: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ ok: false, error: "ZIP creation failed" });
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
  rs.on("error", err => { sendLog(app, `ZIP stream error: ${err.message}`); res.destroy(); onDone(); });
}

/* ======================================================
   STREAM SINGLE URL → BROWSER
====================================================== */
function streamFile(fileUrl, fileName, mimeType, res, app, onDone, redirectCount = 0) {
  if (redirectCount > 5) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: "Too many redirects" });
    return onDone();
  }
  let parsed;
  try { parsed = new URL(fileUrl); }
  catch { if (!res.headersSent) res.status(500).json({ ok: false, error: "Invalid URL" }); return onDone(); }

  const proto = parsed.protocol === "https:" ? https : http;
  const req = proto.request({
    hostname: parsed.hostname,
    path:     parsed.pathname + parsed.search,
    method:   "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer":    "https://www.threads.com/",
    },
  }, (remoteRes) => {
    if (remoteRes.statusCode >= 300 && remoteRes.statusCode < 400 && remoteRes.headers.location)
      return streamFile(new URL(remoteRes.headers.location, fileUrl).toString(), fileName, mimeType, res, app, onDone, redirectCount + 1);
    if (remoteRes.statusCode !== 200) {
      if (!res.headersSent) res.status(500).json({ ok: false, error: `HTTP ${remoteRes.statusCode}` });
      return onDone();
    }
    const cl = remoteRes.headers["content-length"] || "";
    res.setHeader("Content-Type",        remoteRes.headers["content-type"] || mimeType);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    if (cl) res.setHeader("Content-Length", cl);
    res.setHeader("Cache-Control", "no-store");

    let downloaded = 0, total = parseInt(cl, 10) || 0;
    remoteRes.on("data", chunk => {
      downloaded += chunk.length;
      if (total > 0 && app.locals.progressRes && !app.locals.progressRes.writableEnded) {
        app.locals.progressRes.write(`data: ${Math.round(downloaded / total * 100)}\n\n`);
        app.locals.progressRes.flush?.();
      }
    });
    remoteRes.pipe(res);
    remoteRes.on("end",   () => { sendLog(app, `Streamed: ${fileName}`); onDone(); });
    remoteRes.on("error", err => { sendLog(app, `Stream error: ${err.message}`); res.destroy(); onDone(); });
  });

  req.on("error", err => { if (!res.headersSent) res.status(500).json({ ok: false, error: err.message }); onDone(); });
  req.setTimeout(30000, () => { req.destroy(); if (!res.headersSent) res.status(500).json({ ok: false, error: "Timeout" }); onDone(); });
  req.end();
}

/* ======================================================
   SAVE URL → DISK
====================================================== */
function saveToDisk(fileUrl, outPath, app, onDone, redirectCount = 0) {
  if (redirectCount > 5) return onDone(null, new Error("Too many redirects"));
  let parsed;
  try { parsed = new URL(fileUrl); } catch (e) { return onDone(null, e); }

  const proto = parsed.protocol === "https:" ? https : http;
  const req = proto.request({
    hostname: parsed.hostname,
    path:     parsed.pathname + parsed.search,
    method:   "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer":    "https://www.threads.com/",
    },
  }, (remoteRes) => {
    if (remoteRes.statusCode >= 300 && remoteRes.statusCode < 400 && remoteRes.headers.location)
      return saveToDisk(new URL(remoteRes.headers.location, fileUrl).toString(), outPath, app, onDone, redirectCount + 1);
    if (remoteRes.statusCode !== 200) return onDone(null, new Error(`HTTP ${remoteRes.statusCode}`));
    const stream = fs.createWriteStream(outPath);
    remoteRes.pipe(stream);
    stream.on("finish", () => onDone(outPath));
    stream.on("error",  err => onDone(null, err));
  });
  req.on("error", err => onDone(null, err));
  req.setTimeout(30000, () => { req.destroy(); onDone(null, new Error("Timeout")); });
  req.end();
}

/* ======================================================
   SAVE BATCH
====================================================== */
async function saveBatch(items, tempDir, app) {
  const saved = [];
  for (const item of items) {
    if (app.locals.cancelRequested) { sendLog(app, "Canceled"); break; }
    const outPath = path.join(tempDir, item.fileName);
    sendLog(app, `⬇ ${item.fileName}`);
    await new Promise(resolve => {
      saveToDisk(item.url, outPath, app, (savedPath, err) => {
        if (err) {
          sendLog(app, `  ✗ ${item.fileName}: ${err.message}`);
        } else if (savedPath) {
          try {
            if (fs.statSync(savedPath).size > 0) saved.push(savedPath);
            else { sendLog(app, `  ✗ empty`); try { fs.unlinkSync(savedPath); } catch {} }
          } catch {}
        }
        resolve();
      });
    });
  }
  return saved;
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
   MAIN EXPORT
====================================================== */
export async function downloadThreads({ url, mode = "mixed" }, res, app, cookiesPath) {
  app.locals.cancelRequested = false;
  sendLog(app, "Threads: Fetching page…");

  const urlUsername = extractUsernameFromUrl(url);
  const postCode    = extractPostCode(url);
  sendLog(app, `Post code: ${postCode ?? "unknown"}`);

  let html;
  try {
    html = await fetchPage(url);
    sendLog(app, `Page fetched (${Math.round(html.length / 1024)} KB)`);
  } catch (err) {
    sendLog(app, `Page fetch failed: ${err.message}`);
    closeSSE(app);
    if (!res.headersSent)
      return res.status(500).json({ ok: false, error: "THREADS_FETCH_FAILED: " + err.message });
    return;
  }

  const { videos, images, author, strategy } = extractMedia(html, postCode);
  const username = author || urlUsername || "unknown";

  sendLog(app, `Strategy: ${strategy} | Author: ${username}`);
  sendLog(app, `Found: ${videos.length} video(s), ${images.length} image(s)`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "threads-"));
  const cleanup = () => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {} };

  if (videos.length === 0 && images.length === 0) {
    cleanup();
    sendLog(app, "No media found — post may be private");
    closeSSE(app);
    if (!res.headersSent)
      return res.status(500).json({ ok: false, error: "THREADS_NO_MEDIA_FOUND" });
    return;
  }

  // ── Single video ────────────────────────────────────────
  if (videos.length === 1 && images.length === 0) {
    const fileName = buildFileName(username, "mp4");
    sendLog(app, `→ Single video: ${fileName}`);
    closeSSE(app);
    return streamFile(videos[0], fileName, "video/mp4", res, app, cleanup);
  }

  // ── Single image ────────────────────────────────────────
  if (images.length === 1 && videos.length === 0) {
    const ext  = images[0].includes(".png") ? "png" : images[0].includes(".webp") ? "webp" : "jpg";
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const fileName = buildFileName(username, ext);
    sendLog(app, `→ Single image: ${fileName}`);
    closeSSE(app);
    return streamFile(images[0], fileName, mime, res, app, cleanup);
  }

  // ── Multiple media → save all → ZIP → stream ───────────
  sendLog(app, `Carousel: ${videos.length}v + ${images.length}i — downloading all…`);

  const items = [
    ...videos.map((u, i) => ({
      url:      u,
      fileName: buildFileName(username, "mp4", { index: i + 1, type: "vid" }),
    })),
    ...images.map((u, i) => {
      const ext = u.includes(".png") ? "png" : u.includes(".webp") ? "webp" : "jpg";
      return { url: u, fileName: buildFileName(username, ext, { index: i + 1, type: "img" }) };
    }),
  ];

  const saved = await saveBatch(items, tempDir, app);
  sendLog(app, `Saved ${saved.length}/${items.length} files`);

  if (saved.length === 0) {
    closeSSE(app); cleanup();
    if (!res.headersSent)
      return res.status(500).json({ ok: false, error: "THREADS_NO_FILES_SAVED" });
    return;
  }

  // Only 1 survived — stream directly
  if (saved.length === 1) {
    const ext  = path.extname(saved[0]).slice(1) || "mp4";
    const mime = ext === "mp4" ? "video/mp4" : ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : "application/octet-stream";
    closeSSE(app);
    return res.download(saved[0], path.basename(saved[0]), err => { if (err) console.warn(err.message); cleanup(); });
  }

  // Multiple → ZIP
  const zipName = `${safeName(username)}_threads_${todayStr()}.zip`;
  sendLog(app, `Zipping ${saved.length} files → ${zipName}`);
  closeSSE(app);
  return streamZip(saved, zipName, res, app, cleanup);
}