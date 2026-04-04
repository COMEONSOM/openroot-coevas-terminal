// terabox.js — dependency-free Terabox helper (Node 18+)
// Supports both Netscape cookies.txt AND raw browser cookie string

import fs from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";

/* ======================================================
   CONSTANTS
====================================================== */

const API_HOSTS = [
  "https://www.1024tera.com",
  "https://www.terabox.app",
  "https://www.terabox.com",
  "https://www.teraboxapp.com",
];

/* ======================================================
   COOKIE HELPERS
====================================================== */

function parseNetscapeCookies(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return null;

    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    const nonComment = lines.filter(l => !l.startsWith("#"));
    if (nonComment.length === 0) return null;

    const firstLine = nonComment[0];
    const isRawFormat =
      nonComment.length === 1 ||
      (firstLine.includes("=") && !firstLine.includes("\t") && firstLine.includes(";"));

    if (isRawFormat) {
      const cookieStr = nonComment.join("; ").trim();
      console.log(`[Terabox] Parsed raw cookie format (${cookieStr.split(";").length} entries)`);
      return cookieStr || null;
    }

    const cookies = {};
    for (const line of nonComment) {
      const parts = line.split("\t");
      if (parts.length < 7) continue;
      const name = parts[5]?.trim();
      const value = parts[6]?.trim();
      if (name) cookies[name] = value || "";
    }

    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    if (cookieHeader) {
      console.log(`[Terabox] Parsed Netscape cookie format (${Object.keys(cookies).length} entries)`);
    }

    return cookieHeader || null;
  } catch (err) {
    console.warn("[Terabox] Cookie parse error:", err.message);
    return null;
  }
}

function buildHeaders(cookieHeader = null, referer = "https://www.terabox.com/", extra = {}) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": referer,
    ...extra,
  };
  if (cookieHeader) headers["Cookie"] = cookieHeader;
  return headers;
}

/* ======================================================
   RESOLVE SHARE URL → surl + domain
====================================================== */

async function resolveShareUrl(originalUrl, cookieHeader) {
  console.log(`[Terabox] Resolving share URL: ${originalUrl}`);

  const response = await fetch(originalUrl, {
    headers: buildHeaders(cookieHeader, originalUrl),
    redirect: "follow",
  });

  const finalUrl = response.url || originalUrl;
  console.log(`[Terabox] Resolved → ${finalUrl}`);

  const parsed = new URL(finalUrl);
  const domain = parsed.hostname;

  let surl = parsed.searchParams.get("surl");

  if (!surl) {
    const match = parsed.pathname.match(/\/s\/([a-zA-Z0-9_-]+)/);
    if (match) surl = match[1];
  }

  if (!surl) {
    throw new Error(`Could not extract surl from resolved URL: ${finalUrl}`);
  }

  console.log(`[Terabox] surl = ${surl}  domain = ${domain}`);
  return { surl, domain };
}

/* ======================================================
   EXTRACT SIGN + TIMESTAMP
====================================================== */

async function getSignAndTimestamp(surl, domain, cookieHeader) {
  const pageUrl = `https://${domain}/sharing/link?surl=${surl}`;
  console.log(`[Terabox] Fetching sharing page for sign/ts: ${pageUrl}`);

  const response = await fetch(pageUrl, {
    headers: buildHeaders(cookieHeader, pageUrl, {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }),
    redirect: "follow",
  });

  if (!response.ok) {
    console.warn(`[Terabox] Sharing page HTTP ${response.status}`);
    return null;
  }

  const html = await response.text();

  const s1 = html.match(/locals\.sign\s*=\s*["']([^"']+)["']/);
  const t1 = html.match(/locals\.timestamp\s*=\s*["'](\d+)["']/);
  if (s1 && t1) {
    console.log("[Terabox] ✓ Sign/ts (locals)");
    return { sign: s1[1], timestamp: t1[1] };
  }

  const tplMatch = html.match(/var\s+templateData\s*=\s*(\{[\s\S]+?\});/);
  if (tplMatch) {
    try {
      const tpl = JSON.parse(tplMatch[1]);
      if (tpl.sign && tpl.timestamp) {
        console.log("[Terabox] ✓ Sign/ts (templateData)");
        return { sign: tpl.sign, timestamp: String(tpl.timestamp) };
      }
    } catch {}
  }

  const s3 = html.match(/"sign"\s*:\s*"([A-Za-z0-9%+/=_-]{10,})"/);
  const t3 = html.match(/"timestamp"\s*:\s*"?(\\d{8,})["'}]/);
  if (s3 && t3) {
    console.log("[Terabox] ✓ Sign/ts (JSON pattern)");
    return { sign: s3[1], timestamp: t3[1] };
  }

  const initMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\})\s*;/);
  if (initMatch) {
    try {
      const state = JSON.parse(initMatch[1]);
      const sign = state?.share?.sign || state?.sign;
      const ts = state?.share?.timestamp || state?.timestamp;
      if (sign && ts) {
        console.log("[Terabox] ✓ Sign/ts (__INITIAL_STATE__)");
        return { sign, timestamp: String(ts) };
      }
    } catch {}
  }

  const dataInit = html.match(/data-init\s*=\s*'([^']+)'/);
  if (dataInit) {
    try {
      const obj = JSON.parse(dataInit[1]);
      if (obj.sign && obj.timestamp) {
        console.log("[Terabox] ✓ Sign/ts (data-init)");
        return { sign: obj.sign, timestamp: String(obj.timestamp) };
      }
    } catch {}
  }

  console.warn("[Terabox] Could not extract sign/timestamp — will try filemetas fallback");
  return null;
}

/* ======================================================
   GET DLINK
====================================================== */

async function getDlinkForFile(fsId, surl, domain, signData, cookieHeader) {
  const referer = `https://${domain}/sharing/link?surl=${surl}`;

  if (signData?.sign && signData?.timestamp) {
    const hosts = [
      `https://${domain}`,
      "https://www.terabox.com",
      "https://www.1024tera.com",
    ].filter((h, i, a) => a.indexOf(h) === i);

    for (const host of hosts) {
      const url =
        `${host}/api/sharedownload` +
        `?sign=${encodeURIComponent(signData.sign)}` +
        `&timestamp=${encodeURIComponent(signData.timestamp)}` +
        `&surl=${encodeURIComponent(surl)}` +
        `&root=1&fs_id=${encodeURIComponent(fsId)}&channel=web`;

      console.log(`[Terabox] sharedownload → ${host} (fs_id: ${fsId})`);

      try {
        const res = await fetch(url, { headers: buildHeaders(cookieHeader, referer) });
        const data = await res.json().catch(() => null);

        const dlink = data?.dlink || data?.list?.[0]?.dlink;
        if (dlink) {
          console.log(`[Terabox] ✓ dlink via sharedownload from ${host}`);
          return dlink;
        }
        console.warn(`[Terabox] sharedownload errno ${data?.errno ?? "?"} from ${host}`);
      } catch (err) {
        console.warn(`[Terabox] sharedownload error (${host}): ${err.message}`);
      }
    }
  }

  const metaHosts = [
    `https://${domain}`,
    "https://www.terabox.com",
    "https://www.1024tera.com",
  ].filter((h, i, a) => a.indexOf(h) === i);

  for (const host of metaHosts) {
    const url =
      `${host}/api/filemetas` +
      `?dlink=1&fsids=[${fsId}]` +
      `&surl=${encodeURIComponent(surl)}&root=1`;

    console.log(`[Terabox] filemetas → ${host} (fs_id: ${fsId})`);

    try {
      const res = await fetch(url, { headers: buildHeaders(cookieHeader, referer) });
      const data = await res.json().catch(() => null);

      const dlink = data?.info?.[0]?.dlink || data?.list?.[0]?.dlink;
      if (dlink) {
        console.log(`[Terabox] ✓ dlink via filemetas from ${host}`);
        return dlink;
      }
      console.warn(`[Terabox] filemetas errno ${data?.errno ?? "?"} from ${host}`);
    } catch (err) {
      console.warn(`[Terabox] filemetas error (${host}): ${err.message}`);
    }
  }

  return null;
}

/* ======================================================
   FETCH FILE LIST
====================================================== */

async function fetchTeraboxList(surl, domain, cookieHeader, dir = "") {
  const referer = `https://${domain}/sharing/link?surl=${surl}`;

  const hosts = [
    `https://${domain}`,
    ...API_HOSTS,
  ].filter((h, i, a) => a.indexOf(h) === i);

  let lastErr;

  for (const host of hosts) {
    const url =
      `${host}/share/list?app_id=250528&root=1` +
      `&shorturl=${encodeURIComponent(surl)}` +
      (dir ? `&dir=${encodeURIComponent(dir)}` : "");

    console.log(`[Terabox] list API → ${host}`);

    try {
      const response = await fetch(url, {
        headers: buildHeaders(cookieHeader, referer),
      });

      if (!response.ok) {
        console.warn(`[Terabox] list HTTP ${response.status} from ${host}`);
        lastErr = new Error(`HTTP ${response.status} from ${host}`);
        continue;
      }

      const data = await response.json();

      if (!data || !Array.isArray(data.list)) {
        if (data?.errno === -6) {
          throw new Error("Share requires login — refresh cookies_terabox");
        }
        console.warn(`[Terabox] list errno ${data?.errno ?? "?"} from ${host}`);
        lastErr = new Error(`errno ${data?.errno ?? "?"} from ${host}`);
        continue;
      }

      console.log(`[Terabox] ✓ Got ${data.list.length} item(s) from ${host}`);
      return data.list;
    } catch (err) {
      if (err.message.includes("requires login")) throw err;
      console.warn(`[Terabox] list error (${host}): ${err.message}`);
      lastErr = err;
    }
  }

  throw lastErr || new Error("All Terabox list API hosts failed");
}

/* ======================================================
   RECURSIVE FILE LISTING
====================================================== */

async function fetchAllFiles(surl, domain, cookieHeader, dir = "") {
  const list = await fetchTeraboxList(surl, domain, cookieHeader, dir);
  let results = [];

  for (const item of list) {
    if (item.isdir === 1 && item.path) {
      const subFiles = await fetchAllFiles(surl, domain, cookieHeader, item.path);
      results = results.concat(subFiles);
    } else {
      results.push(item);
    }
  }

  return results;
}

/* ======================================================
   FILE TYPE HELPER
====================================================== */

function getFileType(name = "") {
  const ext = name.split(".").pop().toLowerCase();
  if (["mp4", "mkv", "webm", "mov", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "aac", "flac", "ogg", "m4a"].includes(ext)) return "audio";
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "image";
  return "file";
}

/* ======================================================
   DOWNLOAD SINGLE FILE TO TEMP DIR
====================================================== */

async function downloadFileToTemp(dlink, fileName, tmpDir, cookieHeader, referer) {
  const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
  const localPath = path.join(tmpDir, safeName);

  console.log(`[Terabox] Fetching: ${dlink.slice(0, 80)}...`);

  const response = await fetch(dlink, {
    headers: buildHeaders(cookieHeader, referer, { Accept: "*/*" }),
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} downloading "${fileName}"`);
  }

  if (!response.body) {
    throw new Error(`No response body for "${fileName}"`);
  }

  await pipeline(response.body, createWriteStream(localPath));

  const stat = fs.statSync(localPath);
  if (stat.size === 0) {
    fs.unlinkSync(localPath);
    throw new Error(`Downloaded file is empty: "${fileName}"`);
  }

  return localPath;
}

/* ======================================================
   EXTRACT SHORT URL
====================================================== */

export function extractTeraboxShortUrl(url) {
  try {
    if (!url || typeof url !== "string") return null;
    const match = url.match(/\/s\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/* ======================================================
   MAIN HANDLER
====================================================== */

export async function handleTerabox(url, cookiesPath = null) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terabox-"));
  const cookieHeader = parseNetscapeCookies(cookiesPath);

  if (cookiesPath && !cookieHeader) {
    console.warn(`[Terabox] Cookies file found but could not be parsed: ${cookiesPath}`);
  }

  if (cookieHeader) {
    console.log(`[Terabox] Loaded cookies from: ${cookiesPath}`);
    console.log("[Terabox] Using cookies for request");
  } else {
    console.log("[Terabox] No cookies — attempting unauthenticated fetch");
  }

  try {
    const { surl, domain } = await resolveShareUrl(url, cookieHeader);
    const referer = `https://${domain}/sharing/link?surl=${surl}`;

    const signData = await getSignAndTimestamp(surl, domain, cookieHeader);

    console.log(`[Terabox] Fetching file list for surl: ${surl}`);
    const rawFiles = await fetchAllFiles(surl, domain, cookieHeader);

    if (!rawFiles.length) {
      throw new Error("No files found in this Terabox share link");
    }

    console.log(`[Terabox] Found ${rawFiles.length} file(s) — downloading...`);

    const files = [];
    const failedFiles = [];

    for (const raw of rawFiles) {
      const name = raw.server_filename || raw.filename || "unknown";
      let dlink = raw.dlink || null;

      if (!dlink && raw.fs_id) {
        console.log(`[Terabox] No dlink in list — resolving for "${name}"`);
        dlink = await getDlinkForFile(raw.fs_id, surl, domain, signData, cookieHeader);
      }

      if (!dlink) {
        console.warn(`[Terabox] Could not get dlink for "${name}" — skipping`);
        failedFiles.push(name);
        continue;
      }

      try {
        console.log(`[Terabox] Downloading: ${name}`);
        const localPath = await downloadFileToTemp(dlink, name, tmpDir, cookieHeader, referer);

        files.push({
          name,
          path: localPath,
          size: raw.size ?? null,
          type: getFileType(name),
          thumbnail:
            raw.thumbs?.url3 ||
            raw.thumbs?.url2 ||
            raw.thumbs?.url1 ||
            null,
        });

        console.log(`[Terabox] ✓ Saved: ${localPath}`);
      } catch (dlErr) {
        console.error(`[Terabox] ✗ Failed "${name}":`, dlErr.message);
        failedFiles.push(name);
      }
    }

    if (files.length === 0) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      throw new Error(
        failedFiles.length
          ? `All ${failedFiles.length} file(s) failed to download`
          : "No downloadable files found"
      );
    }

    if (failedFiles.length) {
      console.warn(`[Terabox] ${failedFiles.length} file(s) failed: ${failedFiles.join(", ")}`);
    }

    return {
      success: true,
      count: files.length,
      files,
      tmpDir,
    };
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.error("[Terabox] handleTerabox error:", err.message);
    return {
      success: false,
      error: err.message || "Unknown Terabox error",
      files: [],
    };
  }
}