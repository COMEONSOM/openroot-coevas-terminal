import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import https from "https";
import http from "http";
import { sendLog } from "./utils/logStream.js";

/* ======================================================
   CONSTANTS
====================================================== */
const MIN_FILE_BYTES = 10 * 1024;
const MAX_REDIRECTS = 8;
const REQ_TIMEOUT_MS = 30000;

const FB_HOSTS = ["www.facebook.com", "m.facebook.com", "mbasic.facebook.com"];

const HD_VIDEO_FIELDS = [
  "playable_url_quality_hd",
  "hd_src",
  "hd_src_no_ratelimit",
  "browser_native_hd_url",
  "src_hd",
];

const SD_VIDEO_FIELDS = [
  "playable_url",
  "sd_src",
  "sd_src_no_ratelimit",
  "browser_native_sd_url",
  "src_sd",
  "video_url",
  "progressive_url",
];

const ALL_VIDEO_FIELDS = [...HD_VIDEO_FIELDS, ...SD_VIDEO_FIELDS];

const IMAGE_FIELDS = [
  "display_url",
  "uri",
  "image_url",
  "large_share_image",
  "src",
  "url",
];

const SKIP_IMG_PATHS = [
  "/t39.30808-15/",
  "/t15.5256-4/",
  "/t1.6435-",
  "/t31.0-",
  "/t50.",
  "/t51.",
  "/t19.",
  "/t3.",
];

const TINY_DIM_RE = /\/[sqp]\d{1,3}x\d{1,3}\//i;
const REAL_FNAME_RE = /\d{5,}_\d{5,}/;

const PHOTO_TYPENAMES = new Set([
  "Photo",
  "XDTPhoto",
  "PhotoResult",
  "CometPhoto",
  "PhotoAttachment",
  "StillImage",
  "GenericAttachmentMediaPhoto",
  "ProfilePhoto",
  "AlbumPhoto",
  "TimelinePhoto",
  "MediaPhoto",
  "PostPhoto",
  "FeedPhoto",
]);

const VIDEO_TYPENAMES = new Set([
  "Video",
  "XDTVideo",
  "VideoResult",
  "CometVideo",
  "VideoAttachment",
  "VideoStory",
  "MediaVideo",
]);

const VIDEO_EXTS = ["mp4", "mkv", "mov", "webm", "m4v"];
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "avif", "heic"];
const AUDIO_EXTS = ["mp3", "m4a", "aac", "opus", "ogg", "flac", "wav"];
const ALL_EXTS = [...VIDEO_EXTS, ...IMAGE_EXTS];
const ALL_MEDIA_EXTS = [...VIDEO_EXTS, ...IMAGE_EXTS, ...AUDIO_EXTS];

/* ======================================================
   HELPERS
====================================================== */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getPython() {
  return process.platform === "win32" ? "py" : (process.env.PYTHON_BIN || "python3");
}

function safeCleanup(dir) {
  try {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  } catch {}
}

function safeName(v) {
  return (
    String(v || "unknown")
      .replace(/^@/, "")
      .replace(/[^a-z0-9._-]+/gi, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .trim() || "unknown"
  );
}

function buildFileName(username, ext, { index = null, type = null } = {}) {
  const suffix = index !== null && type !== null ? `_${type}${index}` : "";
  return `${safeName(username)}_facebook_${todayStr()}${suffix}.${ext}`;
}

function unesc(str) {
  return String(str || "")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003C/g, "<")
    .replace(/\\u003E/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"");
}

function normalizeFacebookUrl(input = "") {
  let s = String(input || "").trim();

  const md = s.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/i);
  if (md) s = md[2];

  if (
    (s.startsWith("\"") && s.endsWith("\"")) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }

  s = s.replace(/^<|>$/g, "");
  s = unesc(s);

  try {
    const u = new URL(s);
    u.hash = "";
    return u.toString();
  } catch {
    return s;
  }
}

function canonicalFacebookOrigin(urlStr = "") {
  try {
    const u = new URL(normalizeFacebookUrl(urlStr));
    return `https://www.facebook.com${u.pathname}${u.search}`;
  } catch {
    return normalizeFacebookUrl(urlStr);
  }
}

function buildYtDlpCandidateUrls(inputUrl = "") {
  const out = [];
  const seen = new Set();

  const push = v => {
    const s = normalizeFacebookUrl(v);
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  const base = canonicalFacebookOrigin(inputUrl);
  push(base);

  try {
    const u = new URL(base);
    const parts = u.pathname.split("/").filter(Boolean);

    if (parts.length >= 3 && /^posts$/i.test(parts[1])) {
      const user = parts[0];
      const numeric = parts.find(p => /^\d{5,}$/.test(p));
      if (user && numeric) push(`https://www.facebook.com/${user}/posts/${numeric}`);
    }

    const postId = u.pathname.match(/\/posts\/(?:[^/]+\/)?(\d{5,})\/?$/i)?.[1];
    if (postId) {
      const user = u.pathname.match(/^\/([^/]+)\//)?.[1];
      if (user && !["share", "watch", "groups", "events", "pages"].includes(user.toLowerCase())) {
        push(`https://www.facebook.com/${user}/posts/${postId}`);
      }
    }

    const videoId = u.pathname.match(/\/videos\/(\d{5,})/i)?.[1] || u.searchParams.get("v");
    if (videoId && /^\d{5,}$/.test(videoId)) {
      push(`https://www.facebook.com/watch/?v=${videoId}`);
    }

    const storyFbid = u.searchParams.get("story_fbid");
    const profileId = u.searchParams.get("id");
    if (storyFbid && /^\d{5,}$/.test(storyFbid)) {
      if (profileId && /^\d{5,}$/.test(profileId)) {
        push(`https://www.facebook.com/permalink.php?story_fbid=${storyFbid}&id=${profileId}`);
      }
      push(`https://www.facebook.com/story.php?story_fbid=${storyFbid}${profileId ? `&id=${profileId}` : ""}`);
    }

    push(`${u.origin}${u.pathname}`);
  } catch {}

  return out;
}

function looksLikeAuthFailure(text = "") {
  const t = String(text).toLowerCase();
  return (
    t.includes("only available for registered users") ||
    t.includes("use --cookies") ||
    t.includes("login required") ||
    t.includes("requires authentication") ||
    t.includes("login.php") ||
    t.includes("private")
  );
}

function isDnsError(err) {
  const msg = String(err?.message || "");
  return (
    msg.includes("ENOTFOUND") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("getaddrinfo") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("Failed to resolve")
  );
}

function hasMediaHints(text = "") {
  return (
    text.includes("fbcdn") ||
    text.includes("playable_url") ||
    text.includes("image_versions2") ||
    text.includes("album_id") ||
    text.includes("mediaSetID") ||
    text.includes("media_set_id") ||
    text.includes("set=a.") ||
    text.includes("MediaPhoto") ||
    text.includes("MediaVideo") ||
    text.includes("PhotoAttachment") ||
    text.includes("VideoAttachment")
  );
}

function extFromUrl(u = "", fallback = "jpg") {
  const s = String(u).toLowerCase();
  if (s.includes(".png")) return "png";
  if (s.includes(".webp")) return "webp";
  if (s.includes(".gif")) return "gif";
  if (s.includes(".avif")) return "avif";
  if (s.includes(".heic")) return "heic";
  return fallback;
}

/* ======================================================
   CONTENT-TYPE REJECTION
====================================================== */
function isRejectedContentType(contentType = "") {
  const ct = String(contentType).toLowerCase();
  return (
    ct.startsWith("text/") ||
    ct.includes("text/html") ||
    ct.includes("text/plain") ||
    ct.includes("application/json") ||
    ct.includes("application/xhtml") ||
    ct.includes("xml")
  );
}

/* ======================================================
   FILE SIGNATURE DETECTION
====================================================== */
function readFileHead(filePath, maxBytes = 64) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.slice(0, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

function detectDownloadedMediaType(filePath) {
  let head;
  try {
    head = readFileHead(filePath, 64);
  } catch {
    return null;
  }

  if (!head || head.length < 4) return null;

  const ascii = head.toString("latin1");
  const lower = ascii.toLowerCase();

  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg", kind: "image" };
  }

  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (head.length >= 8 && head.slice(0, 8).equals(pngSig)) {
    return { ext: "png", mime: "image/png", kind: "image" };
  }

  if (lower.startsWith("gif87a") || lower.startsWith("gif89a")) {
    return { ext: "gif", mime: "image/gif", kind: "image" };
  }

  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return { ext: "webp", mime: "image/webp", kind: "image" };
  }

  const ftypPos = ascii.indexOf("ftyp");
  if (ftypPos === 4) {
    const brand = ascii.slice(8, 12).replace(/\0/g, "").toLowerCase().trim();

    if (brand === "avif" || brand === "avis") {
      return { ext: "avif", mime: "image/avif", kind: "image" };
    }

    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return { ext: "heic", mime: "image/heic", kind: "image" };
    }

    if (brand === "qt" || brand === "qt  ") {
      return { ext: "mov", mime: "video/quicktime", kind: "video" };
    }

    return { ext: "mp4", mime: "video/mp4", kind: "video" };
  }

  if (
    lower.includes("<html") ||
    lower.includes("<!doctype html") ||
    lower.includes("<body") ||
    lower.includes("login.php")
  ) {
    return null;
  }

  return null;
}

/* ======================================================
   FILE NORMALISATION
====================================================== */
async function normalizeDownloadedMedia(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat || stat.size < MIN_FILE_BYTES) {
    throw new Error(`File too small (${stat?.size || 0} bytes)`);
  }

  let detected = detectDownloadedMediaType(filePath);

  if (!detected) {
    try {
      const sharpMod = await import("sharp");
      const sharp = sharpMod.default || sharpMod;
      const meta = await sharp(filePath).metadata();

      if (meta?.width && meta?.height) {
        if (meta.width < 200 || meta.height < 200) {
          throw new Error(`Image too small (${meta.width}x${meta.height})`);
        }

        const fmtMap = {
          jpeg: { ext: "jpg", mime: "image/jpeg", kind: "image" },
          jpg: { ext: "jpg", mime: "image/jpeg", kind: "image" },
          png: { ext: "png", mime: "image/png", kind: "image" },
          webp: { ext: "webp", mime: "image/webp", kind: "image" },
          gif: { ext: "gif", mime: "image/gif", kind: "image" },
          avif: { ext: "avif", mime: "image/avif", kind: "image" },
          heif: { ext: "heic", mime: "image/heic", kind: "image" },
          heic: { ext: "heic", mime: "image/heic", kind: "image" },
        };

        detected = fmtMap[meta.format] || null;
      }
    } catch (err) {
      if (String(err.message).includes("too small")) throw err;
    }
  }

  if (!detected) {
    throw new Error("Unsupported or unrecognised file format");
  }

  const currentExt = path.extname(filePath).slice(1).toLowerCase();
  let finalPath = filePath;

  if (currentExt !== detected.ext) {
    const newPath = filePath.replace(/\.[^.]+$/, `.${detected.ext}`);
    try {
      fs.renameSync(filePath, newPath);
      finalPath = newPath;
    } catch {}
  }

  return {
    path: finalPath,
    ext: detected.ext,
    mime: detected.mime,
    kind: detected.kind,
  };
}

/* ======================================================
   URL TYPE DETECTION
====================================================== */
function isFacebookStoryUrl(url) {
  try {
    return /\/stories(\/|$)/i.test(new URL(normalizeFacebookUrl(url)).pathname);
  } catch {
    return false;
  }
}

function isFacebookReelOrVideoUrl(url) {
  try {
    const p = new URL(normalizeFacebookUrl(url)).pathname;
    return /\/(reel|reels)(\/|$)/i.test(p) || /\/videos(\/|$)/i.test(p);
  } catch {
    return false;
  }
}

/* ======================================================
   CDN URL VALIDATORS
====================================================== */
function isRealFbVideo(url) {
  if (!url?.startsWith("http")) return false;
  const lower = url.toLowerCase();
  if (!lower.includes("fbcdn.net") && !lower.includes("fbsbx.com")) return false;
  if (lower.includes("static.xx.fbcdn.net") || lower.includes("static.fbcdn.net")) return false;
  return /\.(mp4|mov|webm|m4v)(?:$|\?)/i.test(lower);
}

function isRealFbPhoto(url) {
  if (!url?.startsWith("http")) return false;
  const lower = url.toLowerCase();

  if (!lower.includes("fbcdn.net")) return false;
  if (lower.includes("static.xx.fbcdn.net") || lower.includes("static.fbcdn.net")) return false;
  if (!lower.includes("scontent")) return false;
  if (TINY_DIM_RE.test(lower)) return false;
  if (SKIP_IMG_PATHS.some(t => lower.includes(t))) return false;

  try {
    const parsed = new URL(url);
    const fn = parsed.pathname.split("/").pop()?.split("?")[0] || "";
    const hasImageExt = /\.(jpg|jpeg|png|webp|gif|avif|heic)(?:$|\?)/i.test(fn);
    const looksLikeRealName = REAL_FNAME_RE.test(fn) || /\d{5,}/.test(fn);
    const hasFbTokens =
      parsed.search.includes("_nc_cat=") ||
      parsed.search.includes("stp=") ||
      parsed.search.includes("oh=") ||
      parsed.search.includes("oe=");

    if (!hasImageExt) return false;
    if (!looksLikeRealName && !hasFbTokens) return false;
  } catch {
    return false;
  }

  return true;
}

function mediaId(url) {
  try {
    const fn = new URL(url).pathname.split("/").pop() || "";
    return fn.match(/^(\d{5,}_\d{5,})/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function longestNumericToken(str = "") {
  const matches = String(str).match(/\d{8,}/g) || [];
  return matches.sort((a, b) => b.length - a.length)[0] || "";
}

function stableVideoKey(url = "", fallback = "") {
  try {
    const u = new URL(url);
    const fn = u.pathname.split("/").pop() || "";
    const stem = fn.replace(/\.(mp4|mov|webm|m4v)$/i, "");
    const mid = mediaId(url);
    const num = longestNumericToken(`${u.pathname} ${u.search}`);
    return mid || num || stem || u.pathname || fallback || url;
  } catch {
    return fallback || url;
  }
}

function normalizeVideoAssetKey(key = "") {
  return String(key || "")
    .replace(/[?&#].*$/, "")
    .replace(/\.(mp4|mov|webm|m4v)$/i, "")
    .trim();
}

function stablePhotoKey(url = "", fallback = "") {
  try {
    const u = new URL(url);
    const fn = u.pathname.split("/").pop() || "";
    const stem = fn.replace(/\.(jpg|jpeg|png|webp|gif|avif|heic)$/i, "");
    const mid = mediaId(url);
    const num = longestNumericToken(`${u.pathname} ${u.search}`);
    return mid || num || stem || u.pathname || fallback || url;
  } catch {
    return fallback || url;
  }
}

function normalizePhotoAssetKey(key = "") {
  return String(key || "")
    .replace(/[?&#].*$/, "")
    .replace(/\.(jpg|jpeg|png|webp|gif|avif|heic)$/i, "")
    .replace(/(?:^|[/_-])(?:p|s|q)\d{2,4}x\d{2,4}(?=$|[/_.-])/gi, "")
    .replace(/(?:^|[/_-])q\d{1,3}(?=$|[/_.-])/gi, "")
    .replace(/_+/g, "_")
    .trim();
}

function numericMediaToken(url = "") {
  try {
    const u = new URL(url);
    return longestNumericToken(`${u.pathname} ${u.search}`) || "";
  } catch {
    return "";
  }
}

function scoreFacebookVideoUrl(rawUrl, { field = "", source = "" } = {}) {
  const u = unesc(String(rawUrl || ""));
  if (!isRealFbVideo(u)) return -1e9;

  let score = 0;
  const lower = u.toLowerCase();

  if (source === "typed") score += 100000;
  if (source === "og") score += 30000;
  if (HD_VIDEO_FIELDS.includes(field)) score += 50000;
  if (SD_VIDEO_FIELDS.includes(field)) score += 20000;

  if (lower.includes("hd_src") || lower.includes("quality_hd")) score += 25000;
  if (lower.includes("browser_native_hd")) score += 15000;
  if (lower.includes("no_ratelimit")) score += 5000;
  if (lower.includes("bytestart")) score -= 3000;
  if (lower.includes("range=")) score -= 4000;

  score += Math.min(u.length, 2000);

  const numeric = longestNumericToken(u);
  if (numeric) score += Math.min(numeric.length * 100, 3000);

  return score;
}

function scoreFacebookImageUrl(rawUrl, meta = {}, source = "") {
  const u = unesc(String(rawUrl || ""));
  if (!u.startsWith("http") || !u.includes("fbcdn")) return -1e9;

  let score = 0;
  const lower = u.toLowerCase();
  const width = Number(meta?.width || 0);
  const height = Number(meta?.height || 0);
  const area = width > 0 && height > 0 ? width * height : 0;

  if (source === "explicit_original") score += 1000000;
  if (source === "download") score += 800000;
  if (/_o\.(?:jpe?g|png|webp|gif|avif|heic)(?:$|\?)/i.test(lower)) score += 400000;
  if (lower.includes("viewer_downloadable")) score += 250000;
  if (lower.includes("download")) score += 100000;
  if (lower.includes("original")) score += 80000;

  if (/\/(?:p|s|q)\d{2,4}x\d{2,4}\//i.test(lower)) score -= 300000;
  if (/[/_-](?:p|s)\d{2,4}x\d{2,4}(?:[/_.-]|$)/i.test(lower)) score -= 250000;
  if (/[_-]q\d{1,3}(?:[_.-]|$)/i.test(lower)) score -= 120000;
  if (lower.includes("thumbnail") || lower.includes("thumb")) score -= 120000;
  if (lower.includes("small") || lower.includes("profile") || lower.includes("safe_image")) score -= 80000;
  if (lower.includes("stp=dst-jpg_p") || lower.includes("stp=dst-jpg_s")) score -= 250000;
  if (lower.includes("stp=cp0_dst-jpg_p") || lower.includes("stp=cp0_dst-jpg_s")) score -= 250000;
  if (TINY_DIM_RE.test(lower)) score -= 300000;
  if (SKIP_IMG_PATHS.some(t => lower.includes(t))) score -= 500000;

  if (lower.includes("t39.30808-6")) score += 40000;
  if (lower.includes("t39.30808-5")) score += 25000;
  if (lower.includes("t45.5405-4")) score += 10000;
  if (lower.includes("t45.5405-15")) score += 20000;

  if (area > 0) score += Math.min(area, 50000000) / 25;
  else score -= 5000;

  return score;
}

function uniqueByStableKey(urls = []) {
  const out = [];
  const seen = new Set();

  for (const u of urls) {
    const key = normalizeVideoAssetKey(stableVideoKey(u, u));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }

  return out;
}

/* ======================================================
   HTTP GET MULTI-HOST FALLBACK
====================================================== */
async function httpGetFacebook(urlStr, cookieHeader = null, hops = 0) {
  if (hops > MAX_REDIRECTS) throw new Error("Too many redirects");

  let parsed;
  try {
    parsed = new URL(normalizeFacebookUrl(urlStr));
  } catch {
    throw new Error("Invalid URL");
  }

  const isFbDomain = parsed.hostname.endsWith("facebook.com");
  const hostsToTry = isFbDomain
    ? [parsed.hostname, ...FB_HOSTS.filter(h => h !== parsed.hostname)]
    : [parsed.hostname];

  let lastErr = null;

  for (const host of hostsToTry) {
    try {
      const body = await doGet(host, parsed.pathname, parsed.search, cookieHeader);

      if (body && typeof body === "object" && body.redirect) {
        const loc = body.location;
        if (cookieHeader && (loc.includes("login.php") || loc.includes("login"))) {
          throw new Error("LOGIN_REDIRECT");
        }
        return httpGetFacebook(new URL(loc, urlStr).toString(), cookieHeader, hops + 1);
      }

      return body;
    } catch (err) {
      lastErr = err;
      if (isDnsError(err) && hostsToTry.indexOf(host) < hostsToTry.length - 1) continue;
      throw err;
    }
  }

  throw lastErr || new Error("All Facebook hosts unreachable");
}

function doGet(hostname, pathname, search, cookieHeader) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: pathname + search,
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "identity",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Cache-Control": "no-cache",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
      },
      res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return resolve({ redirect: true, location: res.headers.location });
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        let body = "";
        res.setEncoding("utf8");
        res.on("data", c => (body += c));
        res.on("end", () => resolve(body));
        res.on("error", reject);
      }
    );

    req.on("error", reject);
    req.setTimeout(REQ_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.end();
  });
}

const httpGet = url => httpGetFacebook(url, null);
const httpGetWithCookies = (url, cookieHeader) => httpGetFacebook(url, cookieHeader);

/* ======================================================
   PARSE NETSCAPE COOKIES
====================================================== */
function parseCookiesToHeader(cookiePath) {
  try {
    const lines = fs.readFileSync(cookiePath, "utf8").split("\n");
    return (
      lines
        .filter(l => !l.startsWith("#") && l.includes("\t"))
        .map(l => {
          const parts = l.trim().split("\t");
          if (parts.length >= 7) return `${parts[5]}=${parts[6]}`;
          return null;
        })
        .filter(Boolean)
        .join("; ") || null
    );
  } catch {
    return null;
  }
}

/* ======================================================
   USERNAME / CANONICAL EXTRACTION
====================================================== */
function extractCanonical(html, fallback) {
  const m =
    html.match(/property=["']og:url["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/content=["']([^"']+)["'][^>]+property=["']og:url["']/i);

  return normalizeFacebookUrl(m ? unesc(m[1]) : fallback);
}

function extractUsername(url, html) {
  url = normalizeFacebookUrl(url);

  const pathMatch = url.match(/facebook\.com\/([^/?#]+)\/(posts|videos|photos|reels|reel)\//i)?.[1];
  if (pathMatch) {
    const blocked = ["share", "watch", "groups", "events", "pages", "photo.php", "permalink.php"];
    if (!blocked.includes(String(pathMatch).toLowerCase())) return safeName(pathMatch);
  }

  const storyUser = url.match(/facebook\.com\/([^/?#]+)\/stories/i)?.[1];
  if (storyUser) {
    const blocked = ["stories", "watch", "events", "share"];
    if (!blocked.includes(String(storyUser).toLowerCase())) return safeName(storyUser);
  }

  if (html) {
    const ogTitle =
      html.match(/property=["']og:title["'][^>]+content=["']([^"']{1,120})["']/i)?.[1] ||
      html.match(/content=["']([^"']{1,120})["'][^>]+property=["']og:title["']/i)?.[1];

    if (ogTitle) {
      const m = ogTitle.match(/^([^|•–-]+)/);
      if (m) return safeName(m[1].trim());
    }

    const actorMatch =
      html.match(/"actorName"\s*:\s*"([^"]{2,80})"/i) ||
      html.match(/"author"\s*:\s*"([^"]{2,80})"/i) ||
      html.match(/"page_name"\s*:\s*"([^"]{2,80})"/i);

    if (actorMatch) return safeName(actorMatch[1]);
  }

  const numericId = url.match(/\/(\d{8,})/)?.[1];
  if (numericId) return `fb_${numericId}`;

  return "unknown";
}

/* ======================================================
   JSON BLOB EXTRACTION
====================================================== */
function extractJsonBlobs(text) {
  const blobs = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const blob = text.slice(start, i + 1);
        if (
          blob.includes("fbcdn") ||
          blob.includes("playable_url") ||
          blob.includes("__typename") ||
          blob.includes("image_versions2")
        ) {
          blobs.push(blob);
        }
        start = -1;
      }
    }
  }

  return blobs;
}

function parseAllJsonFromHtml(html) {
  const results = [];

  for (const m of html.matchAll(/require.{5,80}(\[[\s\S]{50,100000}?\])/g)) {
    try {
      results.push(JSON.parse(m[1]));
    } catch {}
  }

  for (const blob of extractJsonBlobs(html)) {
    try {
      results.push(JSON.parse(blob));
    } catch {}
  }

  return results;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function extractTargetTokensFromUrl(urlStr = "") {
  const out = new Set();
  if (!urlStr) return out;

  const normalized = normalizeFacebookUrl(urlStr);
  out.add(String(normalized));

  try {
    const u = new URL(normalized);
    out.add(u.origin + u.pathname);
    out.add(u.pathname);

    for (const key of ["fbid", "story_fbid", "video_id", "v", "id"]) {
      const v = u.searchParams.get(key);
      if (v && /^\d{5,}$/.test(v)) out.add(v);
    }

    const setParam = u.searchParams.get("set");
    const setMatch = String(setParam || "").match(/^a\.(\d{10,})$/);
    if (setMatch) out.add(setMatch[1]);

    const parts = u.pathname.split("/").filter(Boolean);
    for (const part of parts) {
      if (/^\d{5,}$/.test(part)) out.add(part);
      if (/^[A-Za-z0-9._-]{3,}$/.test(part)) out.add(part);
    }

    for (const m of u.pathname.matchAll(/\/(\d{5,})/g)) out.add(m[1]);

    const postId = u.pathname.match(/\/posts\/(\d{5,})/i)?.[1];
    if (postId) out.add(postId);

    const videoId = u.pathname.match(/\/videos\/(\d{5,})/i)?.[1];
    if (videoId) out.add(videoId);
  } catch {}

  return out;
}

function scoreJsonTextForTargets(text, pageUrl = "", canonicalUrl = "") {
  const hay = String(text || "");
  if (!hay) return 0;

  const targets = new Set([
    ...extractTargetTokensFromUrl(pageUrl),
    ...extractTargetTokensFromUrl(canonicalUrl),
  ]);

  let score = 0;
  const canon = String(canonicalUrl || "");
  const page = String(pageUrl || "");

  if (canon && hay.includes(canon)) score += 20000;
  if (page && hay.includes(page)) score += 15000;

  const canonNoQuery = canon.split("?")[0];
  const pageNoQuery = page.split("?")[0];
  if (canonNoQuery && canonNoQuery !== canon && hay.includes(canonNoQuery)) score += 10000;
  if (pageNoQuery && pageNoQuery !== page && hay.includes(pageNoQuery)) score += 8000;

  for (const t of targets) {
    const token = String(t || "");
    if (!token) continue;

    if (hay.includes(`"${token}"`)) score += /^\d{5,}$/.test(token) ? 3500 : 1200;
    if (hay.includes(token)) score += /^\d{5,}$/.test(token) ? 1200 : 300;

    if (/^\d{5,}$/.test(token)) {
      if (hay.includes(`fbid=${token}`)) score += 8000;
      if (hay.includes(`story_fbid=${token}`)) score += 8000;
      if (hay.includes(`video_id=${token}`)) score += 8000;
      if (hay.includes(`/posts/${token}`)) score += 9000;
      if (hay.includes(`/videos/${token}`)) score += 9000;
      if (hay.includes(`/photos/${token}`)) score += 6000;
      if (hay.includes(`/permalink/${token}`)) score += 7000;
      if (hay.includes(`set=a.${token}`)) score += 7000;
      if (hay.includes(`"post_id":"${token}"`) || hay.includes(`"post_id":${token}`)) score += 7000;
      if (hay.includes(`"story_fbid":"${token}"`) || hay.includes(`"story_fbid":${token}`)) score += 9000;
      if (hay.includes(`"feedback_id":"${token}"`) || hay.includes(`"feedback_id":${token}`)) score += 4000;
      if (hay.includes(`"video_id":"${token}"`) || hay.includes(`"video_id":${token}`)) score += 9000;
      if (hay.includes(`"album_id":"${token}"`) || hay.includes(`"album_id":${token}`)) score += 7000;
      if (hay.includes(`"mediaSetID":"${token}"`) || hay.includes(`"mediaSetID":${token}`)) score += 7000;
      if (hay.includes(`"media_set_id":"${token}"`) || hay.includes(`"media_set_id":${token}`)) score += 7000;
    }
  }

  if (hay.includes("fbcdn")) score += 40;
  if (hay.includes("playable_url") || hay.includes("image_versions2")) score += 40;
  if (hay.includes("__typename")) score += 20;
  if (hasMediaHints(hay)) score += 200;

  return score;
}

function collectRelevantJsonRoots(html, pageUrl = "") {
  const roots = parseAllJsonFromHtml(html);
  if (roots.length === 0) return [];

  const canonicalUrl = extractCanonical(html, pageUrl);
  const isAlbumPage = /\/media\/set\/?/i.test(`${pageUrl} ${canonicalUrl}`);

  const scored = roots
    .map((root, idx) => {
      const text = safeJsonStringify(root);
      return { root, idx, text, score: scoreJsonTextForTargets(text, pageUrl, canonicalUrl) };
    })
    .filter(x => x.text);

  if (scored.length === 0) return [];

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

  const best = Number(scored[0]?.score || 0);
  if (best <= 0) return roots.slice(0, isAlbumPage ? 64 : 32);

  const threshold = isAlbumPage
    ? Math.max(800, Math.floor(best * 0.20))
    : Math.max(1200, Math.floor(best * 0.35));

  const picked = scored
    .filter(x => x.score >= threshold || hasMediaHints(x.text))
    .slice(0, isAlbumPage ? 64 : 24)
    .map(x => x.root);

  return picked.length > 0 ? picked : [scored[0].root];
}

function collectRelevantPostNodes(html, pageUrl = "") {
  const canonicalUrl = extractCanonical(html, pageUrl);
  const roots = collectRelevantJsonRoots(html, pageUrl);
  const out = [];
  const seen = new WeakSet();
  const isAlbumPage = /\/media\/set\/?/i.test(`${pageUrl} ${canonicalUrl}`);

  function walk(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 50) return;
    if (seen.has(node)) return;
    seen.add(node);

    const text = safeJsonStringify(node);
    if (text) {
      const score = scoreJsonTextForTargets(text, pageUrl, canonicalUrl);
      if (score >= (isAlbumPage ? 600 : 1500) && hasMediaHints(text)) {
        out.push({ node, score, text });
      }
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }

    for (const val of Object.values(node)) {
      if (val && typeof val === "object") walk(val, depth + 1);
    }
  }

  for (const root of roots) walk(root);

  out.sort((a, b) => b.score - a.score || b.text.length - a.text.length);

  const best = Number(out[0]?.score || 0);
  if (best <= 0) return roots;

  const threshold = isAlbumPage
    ? Math.max(600, Math.floor(best * 0.18))
    : Math.max(1200, Math.floor(best * 0.32));

  return out
    .filter(x => x.score >= threshold || hasMediaHints(x.text))
    .slice(0, isAlbumPage ? 160 : 96)
    .map(x => x.node);
}

/* ======================================================
   ALBUM ID EXTRACTION
====================================================== */
function extractAlbumIds(html, pageUrl) {
  const ids = new Set();

  const addMatches = text => {
    const src = String(text || "");
    if (!src) return;

    for (const m of src.matchAll(/"album_id"\s*:\s*"?(\d{10,})"?/g)) ids.add(m[1]);
    for (const m of src.matchAll(/"mediaSetID"\s*:\s*"?(\d{10,})"?/g)) ids.add(m[1]);
    for (const m of src.matchAll(/"media_set_id"\s*:\s*"?(\d{10,})"?/g)) ids.add(m[1]);
    for (const m of src.matchAll(/set=a\.(\d{10,})/g)) ids.add(m[1]);
    for (const m of src.matchAll(/\/media\/set\/\?set=a\.(\d{10,})/g)) ids.add(m[1]);
  };

  try {
    const u = new URL(normalizeFacebookUrl(pageUrl));
    const setParam = u.searchParams.get("set");
    const m = String(setParam || "").match(/^a\.(\d{10,})$/);
    if (m) ids.add(m[1]);
  } catch {}

  const ogUrl = extractCanonical(html, pageUrl);
  if (ogUrl) addMatches(ogUrl);

  addMatches(pageUrl);
  addMatches(html);

  const sources = [
    ...collectRelevantJsonRoots(html, pageUrl),
    ...collectRelevantPostNodes(html, pageUrl),
  ];

  const seenTexts = new Set();
  for (const source of sources) {
    const text = safeJsonStringify(source);
    if (!text || seenTexts.has(text)) continue;
    seenTexts.add(text);
    addMatches(text);
  }

  return [...ids];
}

/* ======================================================
   IMAGE PICKER
====================================================== */
function pickBestFacebookImage(candidates) {
  const filtered = candidates.filter(c => c?.url);
  if (filtered.length === 0) return null;

  const strong = filtered.filter(
    c => c.source === "explicit_original" || c.source === "download"
  );

  const pool = strong.length > 0 ? strong : filtered;

  let best = null;
  for (const c of pool) {
    const score = scoreFacebookImageUrl(c.url, c.meta, c.source);
    if (!best || score > best.score) best = { ...c, score };
  }

  return best
    ? {
        url: best.url,
        area:
          best.meta?.width && best.meta?.height
            ? best.meta.width * best.meta.height
            : 0,
        score: best.score,
      }
    : null;
}

function bestImageFromNode(node) {
  const candidates = [];

  const pushCandidate = (value, source = "candidate", meta = {}) => {
    if (!value) return;

    const obj = typeof value === "string" ? { url: value } : value;
    const url = unesc(String(obj.uri || obj.src || obj.url || obj.image_url || ""));
    if (!url || !url.startsWith("http") || !url.includes("fbcdn")) return;

    candidates.push({
      url,
      source,
      meta: {
        width: obj.width || meta.width || 0,
        height: obj.height || meta.height || 0,
      },
    });
  };

  const explicitOriginalFields = [
    "high_res_image",
    "original_image",
    "viewer_downloadable_image",
    "download_image",
    "full_resolution_image",
    "downloadable_image",
    "preferred_download_image",
  ];

  for (const f of explicitOriginalFields) {
    pushCandidate(node[f], f.includes("download") ? "download" : "explicit_original");
  }

  const candidateSets = [
    node.image_versions2?.candidates,
    node.photo_image?.image_versions2?.candidates,
    node.full_image?.image_versions2?.candidates,
    node.viewer_image?.image_versions2?.candidates,
    node.large_image?.image_versions2?.candidates,
  ].filter(Array.isArray);

  for (const set of candidateSets) {
    const sorted = [...set].sort((a, b) => {
      const aa = Number(a?.width || 0) * Number(a?.height || 0);
      const bb = Number(b?.width || 0) * Number(b?.height || 0);
      return bb - aa;
    });
    for (const c of sorted) pushCandidate(c, "candidate");
  }

  for (const f of [
    "full_image",
    "large_image",
    "photo_image",
    "image",
    "viewer_image",
    "rendered_image",
    "primary_photo_image",
  ]) {
    pushCandidate(node[f], "named_field");
  }

  for (const f of ["display_url", "uri", "src", "url", "image_url"]) {
    if (typeof node[f] === "string") pushCandidate(node[f], "direct_string");
  }

  return pickBestFacebookImage(candidates);
}

/* ======================================================
   MAIN MEDIA EXTRACTION
====================================================== */
function extractAllPostMedia(html, pageUrl = "") {
  const photoById = new Map();
  const videoById = new Map();

  const typedSources = collectRelevantPostNodes(html, pageUrl);
  const fallbackRoots = collectRelevantJsonRoots(html, pageUrl);
  const walkSources = [...typedSources, ...fallbackRoots];
  const seen = new WeakSet();

  function rememberVideoCandidate(candidate) {
    if (!candidate?.url) return;
    const key = normalizeVideoAssetKey(
      candidate.groupKey || stableVideoKey(candidate.url, candidate.url)
    );
    if (!key) return;

    const prev = videoById.get(key);
    if (!prev || Number(candidate.score || 0) > Number(prev.score || -Infinity)) {
      videoById.set(key, candidate);
    }
  }

  function rememberPhotoCandidate(url, score, explicitKey = "") {
    const key = normalizePhotoAssetKey(
      explicitKey || stablePhotoKey(url, url)
    );
    if (!key) return;

    const prev = photoById.get(key);
    if (!prev || Number(score || 0) > Number(prev.score || -Infinity)) {
      photoById.set(key, { url, area: 0, score });
    }
  }

  function bestVideoFromNode(node) {
    const groupKey = String(
      node.id ||
      node.nid ||
      node.media_id ||
      node.video_id ||
      node.creation_story?.short_form_video_context?.video_owner_type ||
      ""
    ).trim();

    let best = null;

    for (const f of HD_VIDEO_FIELDS) {
      const u = unesc(String(node[f] || ""));
      if (!isRealFbVideo(u)) continue;
      const candidate = {
        url: u,
        score: scoreFacebookVideoUrl(u, { field: f, source: "typed" }),
        field: f,
        groupKey: groupKey || stableVideoKey(u, u),
      };
      if (!best || candidate.score > best.score) best = candidate;
    }

    for (const f of SD_VIDEO_FIELDS) {
      const u = unesc(String(node[f] || ""));
      if (!isRealFbVideo(u)) continue;
      const candidate = {
        url: u,
        score: scoreFacebookVideoUrl(u, { field: f, source: "typed" }),
        field: f,
        groupKey: groupKey || stableVideoKey(u, u),
      };
      if (!best || candidate.score > best.score) best = candidate;
    }

    return best;
  }

  function walkTyped(node, inVideoSubtree = false, depth = 0) {
    if (!node || typeof node !== "object" || depth > 70) return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walkTyped(item, inVideoSubtree, depth + 1);
      return;
    }

    const typename = String(node.__typename || "");

    if (VIDEO_TYPENAMES.has(typename)) {
      const best = bestVideoFromNode(node);
      if (best) rememberVideoCandidate(best);

      for (const val of Object.values(node)) {
        if (val && typeof val === "object") walkTyped(val, true, depth + 1);
      }
      return;
    }

    if (PHOTO_TYPENAMES.has(typename)) {
      if (!inVideoSubtree) {
        const result = bestImageFromNode(node);
        if (result?.url) {
          const key = String(
            node.id ||
            node.nid ||
            node.media_id ||
            mediaId(result.url) ||
            stablePhotoKey(result.url, result.url)
          );
          rememberPhotoCandidate(result.url, Number(result.score || 0), key);
        }
      }

      for (const val of Object.values(node)) {
        if (val && typeof val === "object") walkTyped(val, false, depth + 1);
      }
      return;
    }

    for (const val of Object.values(node)) {
      if (val && typeof val === "object") walkTyped(val, inVideoSubtree, depth + 1);
    }
  }

  for (const source of walkSources) walkTyped(source);

  const sweepTexts = [
    html,
    ...walkSources.map(node => safeJsonStringify(node)).filter(Boolean),
  ];

  const addI = raw => {
    const u = unesc(String(raw || ""));
    if (!isRealFbPhoto(u)) return;

    const score = scoreFacebookImageUrl(u);
    rememberPhotoCandidate(u, score);
  };

  const addVLoose = (raw, source = "regex") => {
    const u = unesc(String(raw || ""));
    if (!isRealFbVideo(u)) return;

    rememberVideoCandidate({
      url: u,
      score: scoreFacebookVideoUrl(u, { source }),
      groupKey: stableVideoKey(u, u),
      field: "",
    });
  };

  for (const sourceText of sweepTexts) {
    for (const f of IMAGE_FIELDS) {
      const re = new RegExp(
        `[\\\\"']${f}[\\\\"']\\s*:\\s*[\\\\"'](https?[^\\\\"'\\s]{10,900}fbcdn(?:\\\\.|\\.)net[^\\\\"'\\s]{0,700})[\\\\"']`,
        "g"
      );
      for (const m of sourceText.matchAll(re)) addI(m[1]);
    }

    for (const m of sourceText.matchAll(
      /(https?:(?:\\\/\\\/|\/\/)[^\s"'`<>\\,]{5,}scontent[^\s"'`<>\\,]{0,80}fbcdn\.net\/[^\s"'`<>\\,]{10,900}\.(?:jpg|jpeg|png|webp|gif|avif|heic)[^\s"'`<>\\,]{0,700})/g
    )) {
      addI(m[1]);
    }
  }

  if (videoById.size === 0) {
    for (const sourceText of sweepTexts) {
      for (const f of ALL_VIDEO_FIELDS) {
        const re = new RegExp(
          `[\\\\"']${f}[\\\\"']\\s*:\\s*[\\\\"'](https?[^\\\\"'\\s]{10,1200})[\\\\"']`,
          "g"
        );
        for (const m of sourceText.matchAll(re)) addVLoose(m[1], "regex-field");
      }

      for (const m of sourceText.matchAll(
        /(https?:(?:\\\/\\\/|\/\/)[^\s"'`<>\\,]{5,}(?:fbcdn|fbsbx)\.net[^\s"'`<>\\,]{0,1200}\.mp4[^\s"'`<>\\,]{0,500})/g
      )) {
        addVLoose(m[1], "regex-url");
      }
    }
  }

  if (videoById.size === 0) {
    for (const m of [
      ...html.matchAll(/property=["']og:video["'][^>]+content=["']([^"']+)["']/gi),
      ...html.matchAll(/content=["']([^"']+)["'][^>]+property=["']og:video["']/gi),
    ]) {
      const u = unesc(m[1]);
      if (!isRealFbVideo(u)) continue;
      rememberVideoCandidate({
        url: u,
        score: scoreFacebookVideoUrl(u, { source: "og" }),
        groupKey: stableVideoKey(u, u),
        field: "",
      });
    }
  }

  if (photoById.size === 0 && videoById.size === 0) {
    for (const m of [
      ...html.matchAll(/property=["']og:image["'][^>]+content=["']([^"']+)["']/gi),
      ...html.matchAll(/content=["']([^"']+)["'][^>]+property=["']og:image["']/gi),
    ]) {
      addI(m[1]);
    }
  }

  const finalVids = uniqueByStableKey(
    [...videoById.values()]
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .map(v => v.url)
  );

  const videoIds = new Set(finalVids.map(u => mediaId(u)).filter(Boolean));
  const videoTokens = new Set(finalVids.map(u => numericMediaToken(u)).filter(Boolean));

  const finalImgs = [];
  const seenImgKeys = new Set();

  const sortedImages = [...photoById.values()].sort(
    (a, b) => Number(b.score || 0) - Number(a.score || 0)
  );

  for (const item of sortedImages) {
    const u = item?.url;
    if (!u) continue;

    const id = mediaId(u);
    if (id && videoIds.has(id)) continue;

    const token = numericMediaToken(u);
    if (token && videoTokens.has(token)) continue;

    const key = normalizePhotoAssetKey(stablePhotoKey(u, u));
    if (!key || seenImgKeys.has(key)) continue;

    seenImgKeys.add(key);
    finalImgs.push(u);
  }

  console.log(`[strict-post-v4] ${finalVids.length}v ${finalImgs.length}i`);
  return { videos: finalVids, images: finalImgs };
}

/* ======================================================
   STORY MEDIA EXTRACTION
====================================================== */
function extractStoryMedia(html) {
  const { videos, images } = extractAllPostMedia(html, "");

  if (videos.length > 0) {
    console.log(`[story] ${videos.length} video(s) — poster frames discarded`);
    return { videos, images: [] };
  }

  if (images.length > 0) {
    console.log(`[story] 0 videos, ${images.length} image(s)`);
    return { videos: [], images };
  }

  const storyImgs = [];
  for (const m of [
    ...html.matchAll(/property=["']og:image["'][^>]+content=["']([^"']+)["']/gi),
    ...html.matchAll(/content=["']([^"']+)["'][^>]+property=["']og:image["']/gi),
  ]) {
    const u = unesc(m[1]);
    if (
      u.startsWith("http") &&
      u.includes("fbcdn.net") &&
      !u.includes("static.xx.fbcdn.net") &&
      !u.includes("static.fbcdn.net")
    ) {
      storyImgs.push(u);
    }
  }

  const deduped = [...new Set(storyImgs)];
  console.log(`[story og:image fallback] ${deduped.length} image(s)`);
  return { videos: [], images: deduped };
}

/* ======================================================
   FULL ALBUM FETCH
====================================================== */
async function fetchFullAlbum(albumId, existingMedia, cookieHeader, app) {
  const albumUrls = [
    `https://www.facebook.com/media/set/?set=a.${albumId}`,
    `https://m.facebook.com/media/set/?set=a.${albumId}`,
    `https://mbasic.facebook.com/media/set/?set=a.${albumId}`,
  ];

  const merged = {
    videos: [...(existingMedia.videos || [])],
    images: [...(existingMedia.images || [])],
  };

  const seenPages = new Set();

  for (const albumUrl of albumUrls) {
    if (seenPages.has(albumUrl)) continue;
    seenPages.add(albumUrl);

    sendLog(app, `Fetching album: ${albumUrl}`);

    let albumHtml = "";
    try {
      albumHtml = cookieHeader
        ? await httpGetFacebook(albumUrl, cookieHeader)
        : await httpGetFacebook(albumUrl);

      sendLog(app, `Album page: ${Math.round(albumHtml.length / 1024)} KB`);
    } catch (err) {
      sendLog(app, `Album fetch failed: ${err.message}`);
      continue;
    }

    const { videos: av, images: ai } = extractAllPostMedia(albumHtml, albumUrl);
    sendLog(app, `Album found: ${av.length}v ${ai.length}i`);

    const seenV = new Set(
      merged.videos.map(u => normalizeVideoAssetKey(stableVideoKey(u, u)))
    );

    const seenI = new Set(
      merged.images.map(u => normalizePhotoAssetKey(stablePhotoKey(u, u)))
    );

    for (const v of av) {
      const k = normalizeVideoAssetKey(stableVideoKey(v, v));
      if (!seenV.has(k)) {
        seenV.add(k);
        merged.videos.push(v);
      }
    }

    for (const img of ai) {
      const k = normalizePhotoAssetKey(stablePhotoKey(img, img));
      if (!seenI.has(k)) {
        seenI.add(k);
        merged.images.push(img);
      }
    }
  }

  merged.videos = uniqueByStableKey(merged.videos);

  const imgSeen = new Set();
  merged.images = merged.images.filter(u => {
    const k = normalizePhotoAssetKey(stablePhotoKey(u, u));
    if (!k || imgSeen.has(k)) return false;
    imgSeen.add(k);
    return true;
  });

  sendLog(app, `Album merge: ${merged.videos.length}v ${merged.images.length}i total`);
  return merged;
}

/* ======================================================
   STORY HANDLER
====================================================== */
async function handleStoryDownload({ storyUrl, cookiesPath, tempDir, res, app, cleanup }) {
  sendLog(app, `handleStoryDownload: ${storyUrl}`);

  const cookieHeader = cookiesPath ? parseCookiesToHeader(cookiesPath) : null;

  let username = "facebook_user";
  try {
    const parts = new URL(normalizeFacebookUrl(storyUrl)).pathname.split("/").filter(Boolean);
    if (parts.length > 0 && parts[0] !== "stories") username = parts[0];
    else if (parts.length > 1) username = parts[1];
  } catch {}

  sendLog(app, "Story: trying yt-dlp…");

  if (cookiesPath && fs.existsSync(cookiesPath)) {
    await runYtDlp({ canonicalUrl: storyUrl, tempDir, cookiesPath, app, audioMode: false });

    const ytStoryFiles = collectFiles(tempDir, ALL_EXTS).filter(f => !f.endsWith(".part"));
    if (ytStoryFiles.length > 0) {
      sendLog(app, `Story: yt-dlp got ${ytStoryFiles.length} file(s)`);
      const done = await deliverFiles(ytStoryFiles, username, "story", res, app, cleanup);
      if (done) return true;
    }

    sendLog(app, "Story: yt-dlp found nothing — trying HTML scrape…");
  }

  let storyHtml = "";
  try {
    storyHtml = await httpGetFacebook(storyUrl, cookieHeader);
    sendLog(app, `Story HTML: ${Math.round(storyHtml.length / 1024)}KB`);
  } catch (e) {
    sendLog(app, `Story fetch failed: ${e.message}`);
  }

  if (!storyHtml) {
    closeSSE(app);
    cleanup();
    return res.status(500).json({
      ok: false,
      error: "STORY_FETCH_FAILED",
      details:
        "Could not fetch story page. The story may have expired (stories last 24 h), be private, or cookies may be stale.",
    });
  }

  let { videos: sv, images: si } = extractStoryMedia(storyHtml);

  if (sv.length === 0 && si.length === 0) {
    for (const host of ["m.facebook.com", "mbasic.facebook.com"]) {
      try {
        const altUrl = normalizeFacebookUrl(storyUrl).replace(
          /^https?:\/\/[^/]+/,
          `https://${host}`
        );
        const ch = await httpGetFacebook(altUrl, cookieHeader);
        ({ videos: sv, images: si } = extractStoryMedia(ch));
        if (sv.length > 0 || si.length > 0) {
          sendLog(app, `Story: found media on ${host}`);
          break;
        }
      } catch {}
    }
  }

  const allItems = [
    ...sv.map((u, i) => ({
      url: u,
      expectedKind: "video",
      fileName: buildFileName(
        username,
        "mp4",
        sv.length + si.length > 1 ? { index: i + 1, type: "vid" } : {}
      ),
    })),
    ...si.map((u, i) => ({
      url: u,
      expectedKind: "image",
      fileName: buildFileName(
        username,
        extFromUrl(u, "jpg"),
        sv.length + si.length > 1 ? { index: i + 1, type: "img" } : {}
      ),
    })),
  ];

  if (allItems.length === 0) {
    closeSSE(app);
    cleanup();
    return res.status(500).json({
      ok: false,
      error: "STORY_NO_MEDIA",
      details:
        "No media found in this story. It may have expired (stories last 24 h), be private, or require fresh cookies.",
    });
  }

  const saved = await saveBatch(allItems, tempDir, app, cookieHeader);
  const done = await deliverFiles(saved, username, "story", res, app, cleanup);

  if (!done) {
    closeSSE(app);
    cleanup();
    res.status(500).json({
      ok: false,
      error: "STORY_EMPTY",
      details: "Story media download failed.",
    });
  }

  return true;
}

/* ======================================================
   STREAM SINGLE URL TO BROWSER
====================================================== */
function streamFile(fileUrl, fileName, mimeType, res, app, onDone, cookieHeader = null, hops = 0) {
  if (hops > 5) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: "Too many redirects" });
    return onDone();
  }

  let parsed;
  try {
    parsed = new URL(fileUrl);
  } catch {
    if (!res.headersSent) res.status(500).json({ ok: false, error: "Invalid URL" });
    return onDone();
  }

  const proto = parsed.protocol === "https:" ? https : http;

  const req = proto.request(
    {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://www.facebook.com",
        "Referer": "https://www.facebook.com/",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    },
    remoteRes => {
      if ([301, 302, 303, 307, 308].includes(remoteRes.statusCode) && remoteRes.headers.location) {
        return streamFile(
          new URL(remoteRes.headers.location, fileUrl).toString(),
          fileName,
          mimeType,
          res,
          app,
          onDone,
          cookieHeader,
          hops + 1
        );
      }

      if (remoteRes.statusCode !== 200) {
        if (!res.headersSent) res.status(500).json({ ok: false, error: `HTTP ${remoteRes.statusCode}` });
        return onDone();
      }

      const cl = remoteRes.headers["content-length"] || "";
      res.setHeader("Content-Type", remoteRes.headers["content-type"] || mimeType);
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      if (cl) res.setHeader("Content-Length", cl);
      res.setHeader("Cache-Control", "no-store");

      let downloaded = 0;
      const total = parseInt(cl, 10) || 0;

      remoteRes.on("data", chunk => {
        downloaded += chunk.length;
        if (total > 0 && app.locals.progressRes && !app.locals.progressRes.writableEnded) {
          app.locals.progressRes.write(`data: ${Math.round((downloaded / total) * 100)}\n\n`);
          app.locals.progressRes.flush?.();
        }
      });

      remoteRes.pipe(res);
      remoteRes.on("end", () => {
        sendLog(app, `Streamed: ${fileName}`);
        onDone();
      });
      remoteRes.on("error", e => {
        sendLog(app, `Stream error: ${e.message}`);
        res.destroy();
        onDone();
      });
    }
  );

  req.on("error", e => {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
    onDone();
  });

  req.setTimeout(REQ_TIMEOUT_MS, () => {
    req.destroy();
    if (!res.headersSent) res.status(500).json({ ok: false, error: "Timeout" });
    onDone();
  });

  req.end();
}

/* ======================================================
   SAVE URL TO DISK
====================================================== */
function saveToDisk(fileUrl, outPath, onDone, cookieHeader = null, hops = 0, expectedKind = null) {
  if (hops > 5) return onDone(null, new Error("Too many redirects"));

  let parsed;
  try {
    parsed = new URL(fileUrl);
  } catch (e) {
    return onDone(null, e);
  }

  const proto = parsed.protocol === "https:" ? https : http;

  const req = proto.request(
    {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://www.facebook.com",
        "Referer": "https://www.facebook.com/",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    },
    remoteRes => {
      if ([301, 302, 303, 307, 308].includes(remoteRes.statusCode) && remoteRes.headers.location) {
        return saveToDisk(
          new URL(remoteRes.headers.location, fileUrl).toString(),
          outPath,
          onDone,
          cookieHeader,
          hops + 1,
          expectedKind
        );
      }

      if (remoteRes.statusCode !== 200) {
        return onDone(null, new Error(`HTTP ${remoteRes.statusCode}`));
      }

      const ct = String(remoteRes.headers["content-type"] || "");
      if (isRejectedContentType(ct)) {
        remoteRes.resume();
        return onDone(null, new Error(`Non-media response (${ct || "unknown content-type"})`));
      }

      const stream = fs.createWriteStream(outPath);
      remoteRes.pipe(stream);

      stream.on("finish", async () => {
        try {
          const normalized = await normalizeDownloadedMedia(outPath);

          if (expectedKind && normalized.kind !== expectedKind) {
            try {
              fs.unlinkSync(normalized.path);
            } catch {}
            return onDone(
              null,
              new Error(`Expected ${expectedKind} but got ${normalized.kind}`)
            );
          }

          onDone(normalized.path);
        } catch (err) {
          try {
            fs.unlinkSync(outPath);
          } catch {}
          onDone(null, err);
        }
      });

      stream.on("error", e => {
        try {
          fs.unlinkSync(outPath);
        } catch {}
        onDone(null, e);
      });
    }
  );

  req.on("error", e => onDone(null, e));
  req.setTimeout(REQ_TIMEOUT_MS, () => {
    req.destroy();
    try {
      fs.unlinkSync(outPath);
    } catch {}
    onDone(null, new Error("Timeout"));
  });

  req.end();
}

/* ======================================================
   SAVE BATCH
====================================================== */
async function saveBatch(items, tempDir, app, cookieHeader = null) {
  const saved = [];

  for (const item of items) {
    if (app.locals.cancelRequested) {
      sendLog(app, "Canceled");
      break;
    }

    const outPath = path.join(tempDir, item.fileName);
    sendLog(app, `⬇ ${item.fileName}`);

    await new Promise(resolve => {
      saveToDisk(
        item.url,
        outPath,
        (savedPath, err) => {
          if (err) {
            sendLog(app, `  ✗ ${item.fileName}: ${err.message}`);
          } else if (savedPath) {
            try {
              const size = fs.statSync(savedPath).size;
              if (size >= MIN_FILE_BYTES) {
                saved.push(savedPath);
                sendLog(app, `  ✓ ${path.basename(savedPath)} (${Math.round(size / 1024)}KB)`);
              } else {
                sendLog(app, `  ✗ ${path.basename(savedPath)}: ${size}B too small — discarded`);
                try {
                  fs.unlinkSync(savedPath);
                } catch {}
              }
            } catch {}
          }
          resolve();
        },
        cookieHeader,
        0,
        item.expectedKind || null
      );
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
      const output = fs.createWriteStream(zipPath);
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

  if (process.platform === "win32") {
    const list = files.map(f => `'${String(f).replace(/'/g, "''")}'`).join(", ");
    const dest = String(zipPath).replace(/'/g, "''");

    await new Promise((resolve, reject) => {
      const proc = spawn(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Compress-Archive -LiteralPath @(${list}) -DestinationPath '${dest}' -Force`,
        ],
        { shell: false, windowsHide: true }
      );

      let stderr = "";
      proc.stderr.on("data", d => (stderr += d));
      proc.on("error", reject);
      proc.on("close", code => (code === 0 ? resolve() : reject(new Error(stderr || `PS exit ${code}`))));
    });

    return zipPath;
  }

  await new Promise((resolve, reject) => {
    const proc = spawn("zip", ["-j", zipPath, ...files], { shell: false });
    proc.on("error", reject);
    proc.on("close", code => (code === 0 ? resolve() : reject(new Error(`zip exit ${code}`))));
  });

  return zipPath;
}

/* ======================================================
   STREAM ZIP
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
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", "no-store");

  const rs = fs.createReadStream(zipPath);
  rs.pipe(res);
  rs.on("end", () => {
    sendLog(app, `ZIP sent: ${zipName}`);
    onDone();
  });
  rs.on("error", e => {
    sendLog(app, `ZIP stream error: ${e.message}`);
    res.destroy();
    onDone();
  });
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
   COLLECT FILES
====================================================== */
function collectFiles(dir, exts) {
  const extSet = new Set(exts);
  const out = [];

  const walk = d => {
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(full);
          continue;
        }
        if (extSet.has(path.extname(e.name).slice(1).toLowerCase())) out.push(full);
      }
    } catch {}
  };

  walk(dir);
  return out;
}

/* ======================================================
   YT-DLP RUNNER
====================================================== */
function runYtDlp({ canonicalUrl, tempDir, cookiesPath, app, audioMode = false }) {
  const countOutputs = () =>
    collectFiles(tempDir, audioMode ? AUDIO_EXTS : ALL_MEDIA_EXTS).filter(f => !f.endsWith(".part")).length;

  const candidates = buildYtDlpCandidateUrls(canonicalUrl);

  return new Promise(resolve => {
    let idx = 0;
    let combinedStderr = "";

    const tryNext = () => {
      if (idx >= candidates.length) {
        return resolve({ ok: countOutputs() > 0, stderr: combinedStderr });
      }

      const candidateUrl = candidates[idx++];
      const outTpl = path.join(tempDir, "%(uploader)s_facebook_%(id)s.%(ext)s");

      const args = [
        "-3",
        "-m",
        "yt_dlp",
        "--no-playlist",
        "--restrict-filenames",
        "--newline",
        "--no-warnings",
        "--retries",
        "10",
        "--fragment-retries",
        "10",
        "--socket-timeout",
        "60",
        "--user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "--add-header",
        "Referer:https://www.facebook.com/",
        "-o",
        outTpl,
      ];

      if (cookiesPath && fs.existsSync(cookiesPath)) {
        args.push("--cookies", cookiesPath);
        sendLog(app, "yt-dlp: using cookies file");
      } else {
        sendLog(app, "yt-dlp: no cookies file");
      }

      if (audioMode) {
        args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
        sendLog(app, "yt-dlp: audio-only mode");
      } else {
        args.push("-f", "bv*+ba/best", "--merge-output-format", "mp4");
      }

      args.push(candidateUrl);
      sendLog(app, `yt-dlp: ${candidateUrl}`);

      const proc = spawn(getPython(), args, { shell: false, windowsHide: true });
      app.locals.currentProc = proc;

      let stderr = "";

      proc.stdout.on("data", d => {
        const t = d.toString();
        sendLog(app, t);
        const m = t.match(/(\d{1,3}(?:\.\d+)?)%/);
        if (m && app.locals.progressRes && !app.locals.progressRes.writableEnded) {
          app.locals.progressRes.write(`data: ${m[1]}\n\n`);
        }
      });

      proc.stderr.on("data", d => {
        const text = d.toString();
        stderr += text;
        combinedStderr += text;
        sendLog(app, `yt-dlp: ${text}`);
      });

      proc.on("error", e => {
        app.locals.currentProc = null;
        combinedStderr += `${e.message}\n`;
        tryNext();
      });

      proc.on("close", code => {
        app.locals.currentProc = null;

        if (countOutputs() > 0) {
          return resolve({ ok: true, stderr: combinedStderr + stderr });
        }

        if (code === 0) {
          return resolve({ ok: true, stderr: combinedStderr + stderr });
        }

        sendLog(app, `yt-dlp: candidate failed (${code})`);
        return tryNext();
      });
    };

    tryNext();
  });
}

/* ======================================================
   DELIVER FILES
====================================================== */
async function deliverFiles(savedFiles, username, label, res, app, cleanup) {
  if (savedFiles.length === 0) return false;

  if (savedFiles.length === 1) {
    const f = savedFiles[0];

    let normalized;
    try {
      normalized = await normalizeDownloadedMedia(f);
    } catch (err) {
      sendLog(app, `  ✗ invalid file removed before delivery: ${err.message}`);
      try {
        fs.unlinkSync(f);
      } catch {}
      return false;
    }

    const finalPath = normalized.path;
    const ext = normalized.ext || path.extname(finalPath).slice(1).toLowerCase() || "mp4";

    const mime =
      ext === "mp4" ? "video/mp4" :
      ext === "mp3" ? "audio/mpeg" :
      ext === "m4a" ? "audio/mp4" :
      ext === "png" ? "image/png" :
      ext === "webp" ? "image/webp" :
      ext === "avif" ? "image/avif" :
      ext === "heic" ? "image/heic" :
      ext === "gif" ? "image/gif" :
      "image/jpeg";

    const fileName = buildFileName(username, ext);
    sendLog(app, `→ Single ${ext}: ${fileName}`);
    closeSSE(app);

    return new Promise(resolve => {
      res.download(finalPath, fileName, err => {
        if (err) console.warn(err.message);
        cleanup();
        resolve(true);
      });
    });
  }

  const renamed = [];
  let vidIdx = 1;
  let imgIdx = 1;
  let audIdx = 1;

  for (const f of savedFiles) {
    const ext = path.extname(f).slice(1).toLowerCase() || "jpg";
    const type = VIDEO_EXTS.includes(ext) ? "vid" : AUDIO_EXTS.includes(ext) ? "aud" : "img";
    const idx = type === "vid" ? vidIdx++ : type === "aud" ? audIdx++ : imgIdx++;

    const newName = buildFileName(username, ext, { index: idx, type });
    const newPath = path.join(path.dirname(f), newName);

    try {
      fs.renameSync(f, newPath);
      renamed.push(newPath);
    } catch {
      renamed.push(f);
    }
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
export async function downloadFacebook({ url, mode = "video" }, res, app, cookiesPath) {
  url = normalizeFacebookUrl(url);
  app.locals.cancelRequested = false;

  const audioMode = mode === "audio";
  sendLog(app, `Facebook v23 DEEP HQ: starting… mode=${mode}`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
  const cleanup = () => safeCleanup(tempDir);
  const cookieHeader = cookiesPath ? parseCookiesToHeader(cookiesPath) : null;

  try {
    /* STAGE 0 — Story */
    if (isFacebookStoryUrl(url)) {
      sendLog(app, "Story URL detected");

      if (!cookiesPath || !fs.existsSync(cookiesPath)) {
        closeSSE(app);
        cleanup();
        return res.status(500).json({
          ok: false,
          error: "STORIES_LOGIN_REQUIRED",
          details:
            "Facebook Stories require login. Export Netscape cookies.txt from Chrome/Edge while logged in to Facebook, then import it in Settings.",
        });
      }

      await handleStoryDownload({ storyUrl: url, cookiesPath, tempDir, res, app, cleanup });
      return;
    }

    /* STAGE 1 — Fetch page HTML */
    let html = "";
    let canonicalUrl = url;
    let fetchFailed = false;

    try {
      sendLog(app, "Fetching page HTML…");
      html = await httpGetFacebook(url, cookieHeader);
      sendLog(app, `Page fetched: ${Math.round(html.length / 1024)} KB`);
      canonicalUrl = normalizeFacebookUrl(extractCanonical(html, url));
      sendLog(app, `Canonical: ${canonicalUrl}`);
    } catch (err) {
      fetchFailed = true;
      sendLog(
        app,
        isDnsError(err)
          ? `DNS failure on all FB hosts: ${err.message} — trying yt-dlp`
          : `Page fetch failed: ${err.message}`
      );
    }

    if (isFacebookStoryUrl(canonicalUrl)) {
      sendLog(app, "Canonical is a story — routing to story handler");

      if (!cookiesPath || !fs.existsSync(cookiesPath)) {
        closeSSE(app);
        cleanup();
        return res.status(500).json({
          ok: false,
          error: "STORIES_LOGIN_REQUIRED",
          details:
            "Facebook Stories require login. Export Netscape cookies.txt from a logged-in browser.",
        });
      }

      await handleStoryDownload({
        storyUrl: canonicalUrl,
        cookiesPath,
        tempDir,
        res,
        app,
        cleanup,
      });
      return;
    }

    const username = extractUsername(canonicalUrl, html);
    sendLog(app, `Author: ${username}`);

    /* STAGE 2 — Reel / single video */
    if (isFacebookReelOrVideoUrl(canonicalUrl)) {
      sendLog(app, `Reel/video — mode: ${mode}`);

      const ytResult = await runYtDlp({
        canonicalUrl,
        tempDir,
        cookiesPath,
        app,
        audioMode,
      });

      const ytFiles = collectFiles(tempDir, audioMode ? AUDIO_EXTS : VIDEO_EXTS).filter(
        f => !f.endsWith(".part")
      );

      if (ytFiles.length > 0) {
        const f = ytFiles[0];
        const ext = path.extname(f).slice(1).toLowerCase() || (audioMode ? "mp3" : "mp4");
        const fileName = buildFileName(username, ext);
        sendLog(app, `→ Reel: ${fileName}`);
        closeSSE(app);

        return new Promise(resolve => {
          res.download(f, fileName, err => {
            if (err) console.warn(err.message);
            cleanup();
            resolve();
          });
        });
      }

      closeSSE(app);
      cleanup();

      const isPrivate = looksLikeAuthFailure(String(ytResult?.stderr || ""));
      return res.status(500).json({
        ok: false,
        error: "REEL_DOWNLOAD_FAILED",
        details: isPrivate
          ? "This reel requires login. Export Netscape cookies.txt and import it in Settings."
          : `Could not download reel${audioMode ? " audio" : ""}. It may be private or unavailable.`,
      });
    }

    /* STAGE 3 — Regular post */
    let { videos, images } = html
      ? extractAllPostMedia(html, canonicalUrl)
      : { videos: [], images: [] };

    sendLog(app, `Extracted: ${videos.length} video(s), ${images.length} image(s)`);

    if (html) {
      const albumIds = extractAlbumIds(html, canonicalUrl);

      if (albumIds.length > 0) {
        sendLog(app, `Album IDs: ${albumIds.join(", ")} — fetching full set`);
        let merged = { videos, images };

        for (const albumId of albumIds) {
          merged = await fetchFullAlbum(albumId, merged, cookieHeader, app);
        }

        videos = uniqueByStableKey(merged.videos);
        images = [...new Set(merged.images)];
        sendLog(app, `After album fetch: ${videos.length}v ${images.length}i`);
      }
    }

    if (videos.length > 0 || images.length > 0) {
      sendLog(app, `→ Post: ${videos.length}v + ${images.length}i`);

      const needIndex = videos.length + images.length > 1;
      const savedPaths = [];

      if (videos.length > 0) {
        sendLog(app, `⬇ trying yt-dlp on post URL variants…`);
        await runYtDlp({ canonicalUrl, tempDir, cookiesPath, app, audioMode: false });

        const ytVids = collectFiles(tempDir, VIDEO_EXTS).filter(f => !f.endsWith(".part"));

        if (ytVids.length > 0) {
          sendLog(app, `  yt-dlp got ${ytVids.length} video(s)`);

          ytVids.forEach((f, i) => {
            const ext = path.extname(f).slice(1).toLowerCase() || "mp4";
            const newName = buildFileName(
              username,
              ext,
              needIndex ? { index: i + 1, type: "vid" } : {}
            );
            const newPath = path.join(tempDir, newName);

            try {
              fs.renameSync(f, newPath);
              savedPaths.push(newPath);
            } catch {
              savedPaths.push(f);
            }
          });
        } else {
          const directVideoCandidates = videos.slice(0, Math.min(videos.length, 2));
          if (videos.length > directVideoCandidates.length) {
            sendLog(
              app,
              `  limiting direct CDN fallback to ${directVideoCandidates.length} best video candidate(s)`
            );
          } else {
            sendLog(app, `  yt-dlp found nothing — direct CDN fallback for ${directVideoCandidates.length} video(s)…`);
          }

          for (let i = 0; i < directVideoCandidates.length; i++) {
            if (app.locals.cancelRequested) break;

            const fileName = buildFileName(
              username,
              "mp4",
              needIndex ? { index: i + 1, type: "vid" } : {}
            );
            const outPath = path.join(tempDir, fileName);

            sendLog(app, `⬇ ${fileName}`);

            await new Promise(resolve => {
              saveToDisk(
                directVideoCandidates[i],
                outPath,
                (savedPath, err) => {
                  if (err) {
                    sendLog(app, `  ✗ ${fileName}: ${err.message}`);
                  } else if (savedPath) {
                    try {
                      const sz = fs.statSync(savedPath).size;
                      if (sz >= MIN_FILE_BYTES) {
                        savedPaths.push(savedPath);
                        sendLog(app, `  ✓ ${fileName} (${Math.round(sz / 1024)}KB)`);
                      } else {
                        sendLog(app, `  ✗ ${fileName}: ${sz}B too small`);
                        try {
                          fs.unlinkSync(savedPath);
                        } catch {}
                      }
                    } catch {}
                  }
                  resolve();
                },
                cookieHeader,
                0,
                "video"
              );
            });
          }
        }
      }

      for (let i = 0; i < images.length; i++) {
        if (app.locals.cancelRequested) break;

        const u = images[i];
        const ext = extFromUrl(u, "jpg");

        const fileName = buildFileName(
          username,
          ext,
          needIndex ? { index: i + 1, type: "img" } : {}
        );
        const outPath = path.join(tempDir, fileName);

        sendLog(app, `⬇ ${fileName}`);

        await new Promise(resolve => {
          saveToDisk(
            u,
            outPath,
            (savedPath, err) => {
              if (err) {
                sendLog(app, `  ✗ ${fileName}: ${err.message}`);
              } else if (savedPath) {
                try {
                  const sz = fs.statSync(savedPath).size;
                  if (sz >= MIN_FILE_BYTES) {
                    savedPaths.push(savedPath);
                    sendLog(app, `  ✓ ${path.basename(savedPath)} (${Math.round(sz / 1024)}KB)`);
                  } else {
                    sendLog(app, `  ✗ ${path.basename(savedPath)}: ${sz}B too small`);
                    try {
                      fs.unlinkSync(savedPath);
                    } catch {}
                  }
                } catch {}
              }
              resolve();
            },
            cookieHeader,
            0,
            "image"
          );
        });
      }

      if (savedPaths.length > 0) {
        const done = await deliverFiles(savedPaths, username, "post", res, app, cleanup);
        if (done) return;
      }
    }

    /* STAGE 4 — yt-dlp fallback */
    sendLog(app, "Scrape insufficient — yt-dlp fallback…");

    const ytResult = await runYtDlp({
      canonicalUrl,
      tempDir,
      cookiesPath,
      app,
      audioMode: false,
    });

    const ytFiles = collectFiles(tempDir, ALL_EXTS).filter(f => !f.endsWith(".part"));

    if (ytFiles.length > 0) {
      const done = await deliverFiles(ytFiles, username, "media", res, app, cleanup);
      if (done) return;
    }

    /* STAGE 5 — All methods failed */
    closeSSE(app);
    cleanup();

    if (fetchFailed && ytFiles.length === 0) {
      return res.status(500).json({
        ok: false,
        error: "FACEBOOK_UNREACHABLE",
        details:
          "The server cannot reach Facebook (DNS failure). Check that your server allows outbound connections to www.facebook.com on port 443.",
      });
    }

    const isPrivate = looksLikeAuthFailure(String(ytResult?.stderr || ""));
    sendLog(app, isPrivate ? "Private post — cookies required" : "All extraction methods failed");

    return res.status(500).json({
      ok: false,
      error: "FACEBOOK_DOWNLOAD_FAILED",
      details: isPrivate
        ? "This post requires login. Export Netscape cookies.txt from Chrome/Edge while logged in to Facebook and import it in Settings."
        : "No media found. The post may be private, deleted, or use an unsupported post type.",
    });
  } catch (err) {
    app.locals.currentProc = null;
    closeSSE(app);
    cleanup();
    console.error("Facebook v23 DEEP HQ exception:", err);
    sendLog(app, `Exception: ${err.message}`);
    return res.status(500).json({
      ok: false,
      error: "FACEBOOK_DOWNLOAD_FAILED",
      details: err.message,
    });
  }
}