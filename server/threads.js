// ======================================================
// THREADS DOWNLOADER — Deep JSON scraper v7
// Fixed: video dedup + mixed content carousel routing
// ======================================================

import path from "path";
import fs   from "fs";
import os   from "os";
import https from "https";
import http  from "http";
import { sendLog } from "./utils/logStream.js";

/* ======================================================
   FETCH PAGE HTML
====================================================== */
function fetchPage(pageUrl, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error("Too many redirects"));

  return new Promise((resolve, reject) => {
    const parsed = new URL(pageUrl);
    const proto  = parsed.protocol === "https:" ? https : http;

    const opts = {
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
        "Sec-Fetch-User":            "?1"
      }
    };

    let html = "";
    const req = proto.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : `https://${parsed.hostname}${res.headers.location}`;
        return fetchPage(next, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode} from Threads`));
      res.setEncoding("utf8");
      res.on("data", (c) => { html += c; });
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
  return str
    .replace(/\\u0026/g, "&").replace(/\\u003C/g, "<")
    .replace(/\\u003E/g, ">").replace(/\\u002F/g, "/")
    .replace(/\\n/g, "")    .replace(/&amp;/g,   "&")
    .replace(/&lt;/g,  "<") .replace(/&gt;/g,    ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g,   "'");
}

/* ======================================================
   IMAGE URL FILTER
====================================================== */
function isValidImageUrl(url) {
  if (!url || !url.startsWith("http")) return false;
  const blocklist = [
    "profile_pic", "s150x150", "s320x320", "s640x640",
    "_s.jpg", "emoji", "rsrc.php", "static.cdninstagram",
    "instagram.com/static", ".gif", "stories", "highlight"
  ];
  return !blocklist.some(b => url.includes(b));
}

/* ======================================================
   EXTRACT CONTENT ID FROM CDN URL
   Works for both images AND videos.
   CDN path: /v/t51.xxx-15/12345_67890_n.jpg
             /v/t50.xxx-16/12345_67890_n.mp4
   Strip quality suffix (_1280x720) so same media at
   different resolutions maps to the same ID.
====================================================== */
function extractContentId(url) {
  try {
    const pathname = new URL(url).pathname;
    // Match the numeric media fingerprint segment
    const match = pathname.match(/\/(\d{5,}_\d+)/);
    if (match) return match[1];
    // Fallback: filename without extension and quality suffix
    const file = path.basename(pathname).replace(/\.[^.]+$/, "");
    return file.replace(/_\d+x\d+$/, "").replace(/[?#].*$/, "");
  } catch { return url; }
}

/* ======================================================
   DEDUPLICATE by content ID — keep highest-res (longest URL)
   Used for BOTH images and videos.
====================================================== */
function deduplicateByContentId(urls) {
  const byId = new Map();
  for (const url of urls) {
    const id = extractContentId(url);
    if (!byId.has(id) || url.length > byId.get(id).length) {
      byId.set(id, url);
    }
  }
  return [...byId.values()];
}

/* ======================================================
   PICK BEST CANDIDATE from candidates[]
====================================================== */
function bestCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  let best = null, bestW = -1;
  for (const c of candidates) {
    if (c && typeof c.url === "string" && c.url.startsWith("http")) {
      const w = typeof c.width === "number" ? c.width : 0;
      if (w > bestW || !best) { bestW = w; best = c.url; }
    }
  }
  return best;
}

/* ======================================================
   EXTRACT FROM image_versions2
====================================================== */
function extractFromImageVersions2(iv2) {
  if (!iv2 || typeof iv2 !== "object") return null;
  if (Array.isArray(iv2.candidates)) return bestCandidate(iv2.candidates);
  if (Array.isArray(iv2))            return bestCandidate(iv2);
  return null;
}

/* ======================================================
   DEEP JSON WALKER
====================================================== */
function walkJson(obj, videos, images, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 50) return;

  if (Array.isArray(obj)) {
    for (const item of obj) walkJson(item, videos, images, depth + 1);
    return;
  }

  // carousel_media: multi-photo/video post
  if (Array.isArray(obj.carousel_media) && obj.carousel_media.length > 0) {
    for (const item of obj.carousel_media) {
      if (!item || typeof item !== "object") continue;
      if (item.image_versions2) {
        const url = extractFromImageVersions2(item.image_versions2);
        if (url && isValidImageUrl(url)) images.add(url);
      }
      if (Array.isArray(item.video_versions)) {
        const url = bestCandidate(item.video_versions);
        if (url) videos.add(url);
      }
      if (typeof item.video_url === "string" && item.video_url.startsWith("http")) {
        videos.add(item.video_url);
      }
    }
  }

  // Single image post
  if (obj.image_versions2 && !obj.carousel_media) {
    const url = extractFromImageVersions2(obj.image_versions2);
    if (url && isValidImageUrl(url)) images.add(url);
  }

  // video_versions[] — single video post
  if (Array.isArray(obj.video_versions) && obj.video_versions.length > 0) {
    const url = bestCandidate(obj.video_versions);
    if (url && url.startsWith("http")) videos.add(url);
  }

  // Direct video_url
  if (
    typeof obj.video_url === "string" &&
    obj.video_url.startsWith("http") &&
    (obj.video_url.includes(".mp4") || obj.video_url.includes("video"))
  ) {
    videos.add(obj.video_url);
  }

  // Fallback image keys
  if (typeof obj.display_url === "string" && isValidImageUrl(obj.display_url))
    images.add(obj.display_url);
  if (typeof obj.image_url === "string" && isValidImageUrl(obj.image_url))
    images.add(obj.image_url);

  for (const val of Object.values(obj)) {
    if (val && typeof val === "object") walkJson(val, videos, images, depth + 1);
  }
}

/* ======================================================
   EXTRACT ALL MEDIA FROM PAGE HTML
====================================================== */
function extractMedia(html) {
  const rawVideos = new Set();
  const images    = new Set();

  // Strategy 1: __NEXT_DATA__
  const nextDataMatch =
    html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i) ||
    html.match(/<script[^>]+type=["']application\/json["'][^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);

  if (nextDataMatch) {
    try {
      walkJson(JSON.parse(nextDataMatch[1]), rawVideos, images);
      console.log(`[threads] __NEXT_DATA__ → ${rawVideos.size}v ${images.size}i (raw)`);
    } catch (e) {
      console.warn("⚠️ __NEXT_DATA__ parse failed:", e.message);
    }
  }

  // Strategy 2: Other script blobs
  if (rawVideos.size === 0 && images.size === 0) {
    for (const sm of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
      const content = sm[1].trim();
      if (content.length < 200) continue;
      if (content.startsWith("{") || content.startsWith("[")) {
        try { walkJson(JSON.parse(content), rawVideos, images); continue; } catch {}
      }
      const a = content.match(/(?:self\.|window\.)?[\w$][\w$.]*\s*=\s*(\{[\s\S]{100,}?\})\s*;?\s*$/);
      if (a) { try { walkJson(JSON.parse(a[1]), rawVideos, images); } catch {} }
    }
    console.log(`[threads] Script walk → ${rawVideos.size}v ${images.size}i (raw)`);
  }

  // Strategy 3: Raw mp4 regex
  if (rawVideos.size === 0) {
    for (const m of html.matchAll(/"(https?:\\?\/\\?\/[^"]*\.mp4[^"]{0,200})"/g)) {
      const url = decodeHTML(m[1].replace(/\\/g, ""));
      if (url.startsWith("http")) rawVideos.add(url);
    }
  }

  // Strategy 4: og:image fallback
  if (images.size === 0) {
    for (const m of [
      ...html.matchAll(/property="og:image"\s+content="([^"]+)"/gi),
      ...html.matchAll(/content="([^"]+)"\s+property="og:image"/gi)
    ]) {
      const url = decodeHTML(m[1]);
      if (isValidImageUrl(url)) images.add(url);
    }
  }

  // ── DEDUPLICATE VIDEOS (same fix as images) ──────────
  // Same video at 720p and 1080p has different CDN URLs
  // but shares the same numeric media fingerprint in path.
  const videos = deduplicateByContentId([...rawVideos]);

  // ── DEDUPLICATE IMAGES ────────────────────────────────
  const dedupedImages = deduplicateByContentId([...images]);

  console.log(`[threads] After dedup: ${videos.length}v ${dedupedImages.length}i`);

  // Strip video thumbnails from images
  const videoHosts = new Set(
    videos.map(v => { try { return new URL(v).hostname; } catch { return ""; } })
  );
  const cleanImages = dedupedImages.filter(img => {
    if (rawVideos.has(img)) return false;
    try {
      const host = new URL(img).hostname;
      if (videoHosts.has(host) && img.includes("efg=")) return false;
    } catch {}
    return true;
  });

  return { videos, images: cleanImages };
}

/* ======================================================
   STREAM REMOTE FILE TO BROWSER
====================================================== */
function streamRemoteFile(fileUrl, fileName, mimeType, res, app, onDone, redirectCount = 0) {
  if (redirectCount > 5) {
    sendLog(app, "Too many redirects");
    if (!res.headersSent) res.status(500).json({ ok: false, error: "Too many redirects" });
    return onDone();
  }

  let parsed;
  try { parsed = new URL(fileUrl); }
  catch {
    if (!res.headersSent) res.status(500).json({ ok: false, error: "Invalid URL" });
    return onDone();
  }

  const proto = parsed.protocol === "https:" ? https : http;

  const req = proto.request({
    hostname: parsed.hostname,
    path:     parsed.pathname + parsed.search,
    method:   "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer":    "https://www.threads.com/"
    }
  }, (remoteRes) => {
    if (remoteRes.statusCode >= 300 && remoteRes.statusCode < 400 && remoteRes.headers.location) {
      return streamRemoteFile(
        remoteRes.headers.location, fileName, mimeType,
        res, app, onDone, redirectCount + 1
      );
    }
    if (remoteRes.statusCode !== 200) {
      if (!res.headersSent) res.status(500).json({ ok: false, error: `HTTP ${remoteRes.statusCode}` });
      return onDone();
    }

    const contentLength = remoteRes.headers["content-length"] || "";
    const detectedMime  = remoteRes.headers["content-type"]   || mimeType;

    res.setHeader("Content-Type",        detectedMime);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    res.setHeader("Cache-Control", "no-store");

    let downloaded = 0;
    const total = parseInt(contentLength, 10) || 0;
    remoteRes.on("data", (chunk) => {
      downloaded += chunk.length;
      if (total > 0 && app.locals.progressRes && !app.locals.progressRes.writableEnded) {
        const pct = Math.round((downloaded / total) * 100);
        app.locals.progressRes.write(`data: ${pct}\n\n`);
        if (typeof app.locals.progressRes.flush === "function") app.locals.progressRes.flush();
      }
    });

    remoteRes.pipe(res);
    remoteRes.on("end",   () => { sendLog(app, `Streamed: ${fileName}`); onDone(); });
    remoteRes.on("error", (err) => { sendLog(app, `Stream error: ${err.message}`); res.destroy(); onDone(); });
  });

  req.on("error", (err) => {
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
    onDone();
  });
  req.setTimeout(30000, () => {
    req.destroy();
    if (!res.headersSent) res.status(500).json({ ok: false, error: "Timeout" });
    onDone();
  });
  req.end();
}

/* ======================================================
   SAVE REMOTE FILE TO DISK
====================================================== */
function saveRemoteFile(fileUrl, outPath, app, onDone, redirectCount = 0) {
  if (redirectCount > 5) return onDone(null, new Error("Too many redirects"));

  let parsed;
  try { parsed = new URL(fileUrl); }
  catch (e) { return onDone(null, e); }

  const proto = parsed.protocol === "https:" ? https : http;

  const req = proto.request({
    hostname: parsed.hostname,
    path:     parsed.pathname + parsed.search,
    method:   "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer":    "https://www.threads.com/"
    }
  }, (remoteRes) => {
    if (remoteRes.statusCode >= 300 && remoteRes.statusCode < 400 && remoteRes.headers.location) {
      return saveRemoteFile(remoteRes.headers.location, outPath, app, onDone, redirectCount + 1);
    }
    if (remoteRes.statusCode !== 200)
      return onDone(null, new Error(`HTTP ${remoteRes.statusCode}`));

    const fileStream = fs.createWriteStream(outPath);
    remoteRes.pipe(fileStream);
    fileStream.on("finish", () => onDone(outPath));
    fileStream.on("error",  (err) => onDone(null, err));
  });

  req.on("error", (err) => onDone(null, err));
  req.setTimeout(30000, () => { req.destroy(); onDone(null, new Error("Timeout")); });
  req.end();
}

/* ======================================================
   CLOSE SSE STREAMS
====================================================== */
function closeSSE(app) {
  if (app.locals.progressRes && !app.locals.progressRes.writableEnded) {
    app.locals.progressRes.write("data: 100\n\n");
    if (typeof app.locals.progressRes.flush === "function") app.locals.progressRes.flush();
    app.locals.progressRes.end();
    app.locals.progressRes = null;
  }
  if (app.locals.logRes && !app.locals.logRes.writableEnded) {
    app.locals.logRes.end();
    app.locals.logRes = null;
  }
}

/* ======================================================
   SAVE BATCH — supports cancel mid-download
====================================================== */
async function saveBatch(items, tempDir, app) {
  // items: [{ url, fileName, ext }]
  const saved = [];
  for (const item of items) {
    if (app.locals.cancelRequested) { sendLog(app, "Canceled by user"); break; }
    const outPath = path.join(tempDir, item.fileName);
    sendLog(app, `⬇ Saving ${item.fileName}`);
    await new Promise((resolve) => {
      saveRemoteFile(item.url, outPath, app, (savedPath, err) => {
        if (err) {
          sendLog(app, `${item.fileName} failed: ${err.message}`);
        } else if (savedPath) {
          try {
            if (fs.statSync(savedPath).size > 0) {
              saved.push(savedPath);
            } else {
              sendLog(app, `${item.fileName} empty — skipping`);
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
   MAIN EXPORT
====================================================== */
export async function downloadThreads({ url, mode = "video" }, res, app, cookiesPath) {
  app.locals.cancelRequested = false;
  sendLog(app, "Threads: Fetching page…");

  // 1. Fetch HTML
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

  // 2. Extract + deduplicate media
  const { videos, images } = extractMedia(html);
  sendLog(app, `Found: ${videos.length} video(s), ${images.length} image(s)`);

  const postId  = url.match(/\/post\/([A-Za-z0-9_-]+)/)?.[1] || "threads";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "threads-"));

  const totalFiles = videos.length + images.length;

  // ── NOTHING FOUND ──────────────────────────────────────
  if (totalFiles === 0) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    sendLog(app, "No media found — post may be private");
    closeSSE(app);
    if (!res.headersSent)
      return res.status(500).json({ ok: false, error: "THREADS_NO_MEDIA_FOUND" });
    return;
  }

  // ── SINGLE VIDEO, NO IMAGES → stream directly ──────────
  if (videos.length === 1 && images.length === 0) {
    const fileName = `threads_${postId}.mp4`;
    sendLog(app, `Single video → ${fileName}`);
    closeSSE(app);
    return streamRemoteFile(videos[0], fileName, "video/mp4", res, app, () => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    });
  }

  // ── SINGLE IMAGE, NO VIDEOS → stream directly ──────────
  if (images.length === 1 && videos.length === 0) {
    const ext      = images[0].includes(".png") ? "png" : "jpg";
    const fileName = `threads_${postId}.${ext}`;
    sendLog(app, `Single image → ${fileName}`);
    closeSSE(app);
    return streamRemoteFile(images[0], fileName, "image/jpeg", res, app, () => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    });
  }

  // ── EVERYTHING ELSE → carousel batch ───────────────────
  // Covers: 1 video + N images, N videos, N images, mixed
  sendLog(app, `Carousel: ${videos.length} video(s) + ${images.length} image(s)`);

  // Build ordered item list: videos first, then images
  const items = [
    ...videos.map((url, i) => ({
      url,
      fileName: `threads_${postId}_vid${i + 1}.mp4`,
      ext:      "mp4"
    })),
    ...images.map((url, i) => ({
      url,
      fileName: `threads_${postId}_img${i + 1}.${url.includes(".png") ? "png" : "jpg"}`,
      ext:      url.includes(".png") ? "png" : "jpg"
    }))
  ];

  const saved = await saveBatch(items, tempDir, app);

  closeSSE(app);

  if (saved.length === 0) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    if (!res.headersSent)
      return res.status(500).json({ ok: false, error: "THREADS_NO_FILES_SAVED" });
    return;
  }

  return res.json({
    ok:     true,
    type:   "carousel",
    count:  saved.length,
    files:  saved.map(f => ({
      name: path.basename(f),
      path: f,
      ext:  path.extname(f).replace(".", "")
    })),
    tmpDir: tempDir
  });
}
