// terabox.js — Coevas Server  (Node 18+)
// Zero external API dependencies (except optional RapidAPI)
//
// .env:  RAPIDAPI_KEY=your_key_here
//
// Download chain:
//   1. RapidAPI  — terabox-downloader-direct-download-link-generator
//                  Tries 4 URL formats, 60s timeout
//   2. yt-dlp   — www.terabox.com/s/ URL (matches TeraBoxIE extractor)
//   3. /api/streaming — jsToken + fid → m3u8 → ffmpeg (all file types)
//   4. Direct dlink  — share/list dlink (fresh cookies)
//   5. WAP API       — /wap/share/filelist
//   6. sign chain    — full auth chain last resort

import fs                    from "fs";
import path                  from "path";
import os                    from "os";
import { spawn }             from "child_process";
import { pipeline }          from "stream/promises";
import { createWriteStream } from "fs";

/* ─────────────────────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────────────────────── */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const RAPIDAPI_HOST = "terabox-downloader-direct-download-link-generator.p.rapidapi.com";
const RAPIDAPI_URL  = `https://${RAPIDAPI_HOST}/fetch`;

const PRIMARY          = "www.teraboxapp.com";
const FALLBACK_DOMAINS = ["www.terabox.app", "www.1024terabox.com", "www.1024tera.com"];

/* ─────────────────────────────────────────────────────────────
   UTILITIES
───────────────────────────────────────────────────────────── */
function getBinPath(name) {
  const exe  = process.platform === "win32" ? `${name}.exe` : name;
  const coev = path.join(os.homedir(), ".coevas", "bin", exe);
  if (fs.existsSync(coev)) return coev;
  const env  = process.env[`${name.toUpperCase()}_BIN`];
  if (env && fs.existsSync(env)) return env;
  return exe;
}

export function extractTeraboxShortUrl(url) {
  return url?.match(/\/s\/([a-zA-Z0-9_-]+)/)?.[1] ?? null;
}

function fileType(n = "") {
  const e = (n.split(".").pop() || "").toLowerCase();
  if (["mp4","mkv","webm","mov","avi","flv","ts"].includes(e)) return "video";
  if (["mp3","wav","aac","flac","ogg","m4a"].includes(e))      return "audio";
  if (["jpg","jpeg","png","gif","webp","avif"].includes(e))    return "image";
  return "file";
}

function safeName(n) {
  return n.replace(/[^\w.\-() ]/g, "_").trim() || "terabox_file";
}

function parseCookieFile(p) {
  const out = { str: "", map: {} };
  try {
    if (!p || !fs.existsSync(p)) return out;
    const pairs = [];
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const f = line.trim().split("\t");
      if (f.length >= 7 && f[5]) {
        const k = f[5].trim(), v = f[6]?.trim() || "";
        pairs.push(`${k}=${v}`);
        out.map[k] = v;
      }
    }
    out.str = pairs.join("; ");
    console.log(`[Terabox] Cookies loaded (${pairs.length}): ${Object.keys(out.map).join(", ")}`);
  } catch (e) { console.warn("[Terabox] Cookie error:", e.message); }
  return out;
}

function hdr(cookieStr = "", jsToken = "", referer = "", extra = {}) {
  const ck = [cookieStr, jsToken ? `jsToken=${jsToken}` : ""].filter(Boolean).join("; ");
  return {
    "User-Agent":         UA,
    "Accept-Language":    "en-US,en;q=0.9",
    "Accept-Encoding":    "gzip, deflate, br",
    "Cache-Control":      "no-cache",
    "Sec-Ch-Ua":          '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile":   "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest":     "empty",
    "Sec-Fetch-Mode":     "cors",
    "Sec-Fetch-Site":     "same-origin",
    "DNT":                "1",
    ...(referer ? { Referer: referer } : {}),
    ...(ck      ? { Cookie:  ck }      : {}),
    ...extra,
  };
}

function apiHdr(cookieStr = "", jsToken = "", referer = "") {
  return hdr(cookieStr, jsToken, referer, {
    Accept:             "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
  });
}

function extractJsToken(html) {
  if (!html) return "";
  let m;
  m = html.match(/fn%28%22([A-Fa-f0-9]{20,})%22/i);        if (m) return m[1];
  m = html.match(/var%20a%3D%22([A-Fa-f0-9]{20,})%22/i);   if (m) return m[1];
  let decoded = html;
  try { decoded = decodeURIComponent(html); } catch {}
  m = decoded.match(/window\.jsToken\s*=\s*["']([A-Fa-f0-9]{20,})["']/i); if (m) return m[1];
  m = decoded.match(/\bfn\s*\(\s*["']([A-Fa-f0-9]{20,})["']/i);           if (m) return m[1];
  m = decoded.match(/var\s+a\s*=\s*["']([A-Fa-f0-9]{20,})["']\s*;[^"']{0,200}jsToken\s*=\s*a/i); if (m) return m[1];
  m = decoded.match(/"jsToken"\s*:\s*"([^"]{20,})"/i);                    if (m) return m[1];
  return "";
}

async function dlDirect(url, dest, cookieStr = "", jsToken = "", referer = "") {
  const r = await fetch(url, {
    headers: { ...hdr(cookieStr, jsToken, referer), Accept: "*/*" },
    redirect: "follow",
  });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  await pipeline(r.body, createWriteStream(dest));
  const { size } = fs.statSync(dest);
  if (!size) { fs.rmSync(dest, { force: true }); throw new Error("Empty file"); }
  return size;
}

function dlM3u8(m3u8Url, dest, cookieStr = "", jsToken = "") {
  return new Promise((resolve, reject) => {
    const ffmpeg = getBinPath("ffmpeg");
    const ck = [cookieStr, jsToken ? `jsToken=${jsToken}` : ""].filter(Boolean).join("; ");
    const args = [
      "-y",
      "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
      ...(ck ? ["-headers", `Cookie: ${ck}\r\nUser-Agent: ${UA}\r\n`] : []),
      "-i", m3u8Url, "-c", "copy", "-bsf:a", "aac_adtstoasc", dest,
    ];
    let errBuf = "";
    const proc = spawn(ffmpeg, args, { stdio: ["ignore","pipe","pipe"] });
    proc.stderr.on("data", d => { errBuf += d.toString(); });
    proc.on("error", reject);
    proc.on("close", code => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${errBuf.slice(-300)}`));
      resolve();
    });
  });
}

async function tmpFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .map(f => path.join(dir, f))
      .filter(fp => { try { const s = fs.statSync(fp); return s.isFile() && s.size > 0; } catch { return false; } });
  } catch { return []; }
}

/* ─────────────────────────────────────────────────────────────
   SHARED: resolve surl + jsToken
───────────────────────────────────────────────────────────── */
async function resolveMeta(shortCode, cookieStr, cookieMap) {
  let surl    = shortCode;
  let jsToken = cookieMap.jsToken || cookieMap.jstoken || "";

  for (const dom of [PRIMARY, "www.1024terabox.com", ...FALLBACK_DOMAINS]) {
    try {
      const r = await fetch(`https://${dom}/s/${shortCode}`, {
        headers: hdr(cookieStr, "", `https://${dom}/`), redirect: "follow",
      });
      if (r.ok) {
        const resolved = new URL(r.url).searchParams.get("surl") || shortCode;
        if (resolved !== shortCode) {
          surl = resolved;
          console.log(`[Terabox] surl=${surl} (via ${dom})`);
          break;
        }
      }
    } catch {}
  }

  if (!jsToken) {
    for (const dom of [PRIMARY, "www.1024terabox.com", ...FALLBACK_DOMAINS]) {
      try {
        const r = await fetch(`https://${dom}/sharing/link?surl=${surl}`, {
          headers: hdr(cookieStr, "", `https://${dom}/`), redirect: "follow",
        });
        if (r.ok) {
          const html = await r.text();
          console.log(`[Terabox] Page HTML: ${html.length} chars (${dom})`);
          jsToken = extractJsToken(html);
          if (jsToken) { console.log(`[Terabox] jsToken ✓ (len=${jsToken.length})`); break; }
          else         console.warn(`[Terabox] jsToken NOT found on ${dom}`);
        }
      } catch (e) { console.warn(`[Terabox] Page fetch error (${dom}):`, e.message); }
    }
  }

  return { surl, jsToken };
}

/* ─────────────────────────────────────────────────────────────
   SHARED: get file list
───────────────────────────────────────────────────────────── */
async function getFileList(surl, cookieStr, jsToken) {
  for (const dom of [PRIMARY, "www.1024terabox.com", ...FALLBACK_DOMAINS]) {
    for (const root of ["1","0"]) {
      try {
        const qs = new URLSearchParams({
          app_id:"250528", shorturl:surl, root, web:"1",
          channel:"dubox", clienttype:"0",
          ...(jsToken ? { jsToken } : {}),
        });
        const r = await fetch(`https://${dom}/share/list?${qs}`, {
          headers: apiHdr(cookieStr, jsToken, `https://${dom}/sharing/link?surl=${surl}`),
        });
        if (!r.ok) continue;
        const data = await r.json();
        console.log(`[Terabox] share/list root=${root} (${dom}): errno=${data?.errno} items=${data?.list?.length??0}`);
        if (!Array.isArray(data?.list) || !data.list.length) continue;
        const hasDlink = data.list.some(f => !!f.dlink);
        console.log(`[Terabox] share/list ✓ ${data.list.length} item(s), dlink=${hasDlink}`);
        return { list:data.list, shareid:String(data.shareid||""), uk:String(data.uk||""), hasDlink, dom };
      } catch {}
    }
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────
   METHOD 1 — RapidAPI
   Tries 4 URL formats, 60s timeout per attempt
───────────────────────────────────────────────────────────── */
async function methodRapidApi(surl, tmpDir, shortCode = "") {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) { console.log("[Terabox][1-rapid] RAPIDAPI_KEY not set — skipping"); return { success: false }; }

  // Try multiple URL formats — RapidAPI may handle some better than others
  const urlsToTry = [
    ...(shortCode ? [`https://www.teraboxapp.com/s/${shortCode}`] : []),
    `https://www.terabox.app/sharing/link?surl=${surl}`,
    `https://www.teraboxapp.com/sharing/link?surl=${surl}`,
    `https://www.1024tera.com/sharing/link?surl=${surl}`,
  ];

  let resData = null;
  for (const shareUrl of urlsToTry) {
    console.log(`[Terabox][1-rapid] Trying: ${shareUrl}`);
    try {
      const r = await fetch(RAPIDAPI_URL, {
        method: "POST",
        headers: {
          "Content-Type":    "application/json",
          "x-rapidapi-host": RAPIDAPI_HOST,
          "x-rapidapi-key":  key,
        },
        body:   JSON.stringify({ url: shareUrl }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        console.warn(`[Terabox][1-rapid] HTTP ${r.status}: ${txt.slice(0, 200)}`);
        continue;
      }

      const data = await r.json();
      console.log(`[Terabox][1-rapid] Response: ${JSON.stringify(data).slice(0, 300)}`);

      const hasData =
        data.download_url || data.downloadUrl || data.link || data.dlink ||
        data.url || data.HD || data.SD || data.direct_url ||
        (Array.isArray(data) && data.length > 0) ||
        data.data || data.response || data.result;

      if (hasData) { resData = data; break; }
      console.warn(`[Terabox][1-rapid] No download URL in response — trying next format`);
    } catch (e) {
      console.warn(`[Terabox][1-rapid] Error (${shareUrl}):`, e.message);
    }
  }

  if (!resData) return { success: false };

  /* ── Flexible response parser ── */
  const items = [];
  const extract = (obj) => {
    if (!obj || typeof obj !== "object") return;
    const dlUrl =
      obj.download_url || obj.downloadUrl || obj.direct_url ||
      obj.url          || obj.dlink        || obj.link       ||
      obj.hd           || obj.HD           || obj.sd         || obj.SD || null;
    const name  = obj.file_name || obj.filename || obj.title || obj.name || "terabox_file";
    const thumb = obj.thumbnail || obj.image    || obj.cover || null;
    const size  = obj.size      || obj.filesize || 0;
    if (dlUrl) items.push({ dlUrl, name, thumb, size });
    for (const key of ["data","response","result","file","resolutions","info"]) {
      if (obj[key] && typeof obj[key] === "object") extract(obj[key]);
    }
  };

  if (Array.isArray(resData)) resData.forEach(extract);
  else extract(resData);

  if (!items.length) {
    console.warn("[Terabox][1-rapid] Could not parse download URL from response");
    return { success: false };
  }

  const files = [];
  for (const { dlUrl, name, thumb, size } of items) {
    const dest = path.join(tmpDir, safeName(name));
    try {
      const r = await fetch(dlUrl, {
        headers: { "User-Agent": UA, Accept: "*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(300_000), // 5 min for large files
      });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      await pipeline(r.body, createWriteStream(dest));
      const { size: finalSize } = fs.statSync(dest);
      if (!finalSize) { fs.rmSync(dest, { force: true }); continue; }
      files.push({ name, path:dest, size:finalSize, type:fileType(name), thumbnail:thumb });
      console.log(`[Terabox][1-rapid] ✓ ${name} (${finalSize} bytes)`);
    } catch (e) { console.error(`[Terabox][1-rapid] DL error "${name}":`, e.message); }
  }

  if (!files.length) return { success: false };
  return { success:true, count:files.length, files, tmpDir };
}

/* ─────────────────────────────────────────────────────────────
   METHOD 2 — yt-dlp
   www.terabox.com/s/CODE  — matches TeraBoxIE extractor
───────────────────────────────────────────────────────────── */
async function methodYtdlp(shortCode, cookiesPath, tmpDir) {
  const ytdlp  = getBinPath("yt-dlp");
  const ytUrl  = `https://www.terabox.com/s/${shortCode}`;
  const outTpl = path.join(tmpDir, "%(title)s.%(ext)s");

  const args = [
    "--no-playlist",
    "--format", "bv*+ba/b/best",
    "--merge-output-format", "mp4",
    "--output", outTpl,
    "--no-warnings", "--newline", "--retries", "3",
  ];
  if (cookiesPath && fs.existsSync(cookiesPath)) args.push("--cookies", cookiesPath);
  args.push(ytUrl);

  console.log(`[Terabox][2-ytdlp] URL: ${ytUrl}`);

  return new Promise((resolve) => {
    let stderr = "";
    const proc = spawn(ytdlp, args, { stdio: ["ignore","pipe","pipe"] });
    proc.stdout.on("data", d => { const l = d.toString().trim(); if (l) console.log(`[yt-dlp] ${l}`); });
    proc.stderr.on("data", d => { stderr += d.toString(); });
    proc.on("error", e => { console.warn("[2-ytdlp] spawn:", e.message); resolve({ success:false }); });
    proc.on("close", async code => {
      if (code !== 0) {
        console.warn(`[Terabox][2-ytdlp] exit ${code}`);
        if (stderr.trim()) console.warn(stderr.slice(-400));
        return resolve({ success:false });
      }
      const files = await tmpFiles(tmpDir);
      if (!files.length) return resolve({ success:false });
      console.log(`[Terabox][2-ytdlp] ✓ ${files.length} file(s)`);
      resolve({
        success:true, count:files.length, tmpDir,
        files: files.map(f => ({ name:path.basename(f), path:f,
          size:fs.statSync(f).size, type:fileType(path.basename(f)), thumbnail:null })),
      });
    });
  });
}

/* ─────────────────────────────────────────────────────────────
   METHOD 3 — /api/streaming
   Tries ALL file types (not just video) — logs every file
───────────────────────────────────────────────────────────── */
async function methodStreaming(surl, cookieStr, jsToken, fileList, tmpDir) {
  if (!jsToken) { console.warn("[Terabox][3-stream] No jsToken"); return { success:false }; }

  const QTYPES = ["M3U8_AUTO_1080","M3U8_AUTO_720","M3U8_AUTO_480","M3U8_AUTO_360","M3U8_AUTO_240"];
  const files = [];

  console.log(`[Terabox][3-stream] fileList has ${fileList.length} item(s)`);
  for (const item of fileList) {
    const name  = item.server_filename || item.filename || "file";
    const ftype = fileType(name);
    console.log(`[Terabox][3-stream] item: "${name}" | isdir=${item.isdir} | type=${ftype} | fid=${item.fs_id}`);
    if (item.isdir == "1" || item.isdir === 1 || item.isdir === true) { console.log(`[Terabox][3-stream]   → skipping folder`); continue; }

    // Try streaming for ALL types — Terabox server decides what's streamable
    let streamUrl = null;
    for (const qt of QTYPES) {
      try {
        const qs = new URLSearchParams({
          app_id:"250528", channel:"dubox", clienttype:"0",
          jsToken, shorturl:surl, fid:String(item.fs_id), type:qt,
        });
        const r = await fetch(`https://${PRIMARY}/api/streaming?${qs}`, {
          headers: apiHdr(cookieStr, jsToken, `https://${PRIMARY}/sharing/link?surl=${surl}`),
        });
        if (!r.ok) continue;
        const data = await r.json();
        console.log(`[Terabox][3-stream]   errno=${data?.errno} type=${qt}`);
        streamUrl = data?.streaming_src || data?.hls_mp4_url || null;
        if (streamUrl) { console.log(`[Terabox][3-stream]   streamUrl ✓`); break; }
      } catch {}
    }

    if (!streamUrl) { console.warn(`[Terabox][3-stream]   No stream URL`); continue; }
    const dest = path.join(tmpDir, safeName(name.replace(/\.[^.]+$/, ".mp4")));
    try {
      await dlM3u8(streamUrl, dest, cookieStr, jsToken);
      const { size } = fs.statSync(dest);
      files.push({ name, path:dest, size, type:ftype||"video",
        thumbnail:item.thumbs?.url3||item.thumbs?.url2||null });
      console.log(`[Terabox][3-stream] ✓ ${name}`);
    } catch (e) { console.error(`[3-stream] ffmpeg error "${name}":`, e.message); }
  }

  if (!files.length) return { success:false };
  return { success:true, count:files.length, files, tmpDir };
}

/* ─────────────────────────────────────────────────────────────
   METHOD 4 — Direct dlink
───────────────────────────────────────────────────────────── */
async function methodDirectDlink(surl, cookieStr, jsToken, listResult, tmpDir) {
  if (!listResult?.hasDlink) { console.log("[Terabox][4-dlink] No dlinks"); return { success:false }; }
  const files = [];
  for (const item of listResult.list) {
    if (item.isdir == "1" || item.isdir === 1 || item.isdir === true || !item.dlink) continue;
    const name = item.server_filename || item.filename || "file";
    const dest = path.join(tmpDir, safeName(name));
    try {
      await dlDirect(item.dlink, dest, cookieStr, jsToken, `https://${PRIMARY}/`);
      const { size } = fs.statSync(dest);
      files.push({ name, path:dest, size, type:fileType(name),
        thumbnail:item.thumbs?.url3||item.thumbs?.url2||null });
      console.log(`[Terabox][4-dlink] ✓ ${name}`);
    } catch (e) { console.error(`[4-dlink] "${name}":`, e.message); }
  }
  if (!files.length) return { success:false };
  return { success:true, count:files.length, files, tmpDir };
}

/* ─────────────────────────────────────────────────────────────
   METHOD 5 — WAP API
───────────────────────────────────────────────────────────── */
async function methodWap(surl, cookieStr, jsToken, tmpDir) {
  let wapList = [];
  for (const d of [PRIMARY, ...FALLBACK_DOMAINS]) {
    try {
      const qs = new URLSearchParams({
        app_id:"250528", shorturl:surl, page:"1", num:"20",
        by:"name", order:"asc", channel:"dubox", clienttype:"5",
        ...(jsToken ? { jsToken } : {}),
      });
      const r = await fetch(`https://${d}/wap/share/filelist?${qs}`, {
        headers: apiHdr(cookieStr, jsToken, `https://${d}/wap/share/link?surl=${surl}`),
      });
      if (!r.ok) continue;
      const data = await r.json();
      console.log(`[Terabox][5-wap] errno=${data?.errno} (${d})`);
      if (Array.isArray(data?.list) && data.list.length) { wapList = data.list; break; }
    } catch {}
  }
  if (!wapList.length) return { success:false };
  const files = [];
  for (const item of wapList) {
    if (item.isdir == "1" || item.isdir === 1 || item.isdir === true || !item.dlink) continue;
    const name = item.server_filename || item.filename || "file";
    const dest = path.join(tmpDir, safeName(name));
    try {
      await dlDirect(item.dlink, dest, cookieStr, jsToken, `https://${PRIMARY}/`);
      const { size } = fs.statSync(dest);
      files.push({ name, path:dest, size, type:fileType(name),
        thumbnail:item.thumbs?.url3||item.thumbs?.url2||null });
      console.log(`[Terabox][5-wap] ✓ ${name}`);
    } catch (e) { console.error(`[5-wap] "${name}":`, e.message); }
  }
  if (!files.length) return { success:false };
  return { success:true, count:files.length, files, tmpDir };
}

/* ─────────────────────────────────────────────────────────────
   METHOD 6 — sign/timestamp chain
───────────────────────────────────────────────────────────── */
async function methodSign(surl, cookieStr, jsToken, listResult, tmpDir) {
  let sign = "", timestamp = "", shareid = listResult?.shareid||"", uk = listResult?.uk||"";

  for (const d of [PRIMARY, ...FALLBACK_DOMAINS]) {
    for (const pname of ["shorturl","surl"]) {
      try {
        const qs = new URLSearchParams({ app_id:"250528", root:"1", web:"1",
          channel:"dubox", clienttype:"0", ...(jsToken?{jsToken}:{}) });
        qs.set(pname, surl);
        const r = await fetch(`https://${d}/api/shorturlinfo?${qs}`, {
          headers: apiHdr(cookieStr, jsToken, `https://${d}/sharing/link?surl=${surl}`),
        });
        if (!r.ok) continue;
        const data = await r.json();
        console.log(`[Terabox][6-sign] shorturlinfo [${pname}] errno=${data?.errno} (${d})`);
        if (data?.sign) {
          sign=String(data.sign); timestamp=String(data.timestamp||"");
          if (!shareid&&data.shareid) shareid=String(data.shareid);
          if (!uk&&data.uk)           uk=String(data.uk);
          break;
        }
      } catch {}
    }
    if (sign) break;
  }

  if (!sign) { console.warn("[Terabox][6-sign] No sign — skip"); return { success:false }; }

  const fileList = listResult?.list||[];
  if (!fileList.length) return { success:false };

  const files = [];
  for (const raw of fileList) {
    if (raw.isdir == "1" || raw.isdir === 1 || raw.isdir === true) continue;
    const name = raw.server_filename||raw.filename||"file";
    let   dlink = raw.dlink||null;

    if (!dlink) {
      for (const d of [PRIMARY, ...FALLBACK_DOMAINS]) {
        try {
          const q = new URLSearchParams({ app_id:"250528", web:"1", channel:"dubox", clienttype:"0",
            sign, timestamp, shareid, uk, primaryid:shareid, product:"share", nozip:"0",
            fid_list:JSON.stringify([Number(raw.fs_id)]), ...(jsToken?{jsToken}:{}) });
          const r = await fetch(`https://${d}/share/download?${q}`, {
            headers: apiHdr(cookieStr, jsToken, `https://${d}/sharing/link?surl=${surl}`),
          });
          if (!r.ok) continue;
          const data = await r.json();
          console.log(`[Terabox][6-sign] share/download errno=${data?.errno} (${d})`);
          dlink = data?.dlink||(Array.isArray(data?.list)?data.list[0]?.dlink:null)||null;
          if (dlink) break;
        } catch {}
      }
    }

    if (!dlink) continue;
    const dest = path.join(tmpDir, safeName(name));
    try {
      await dlDirect(dlink, dest, cookieStr, jsToken, `https://${PRIMARY}/`);
      const { size } = fs.statSync(dest);
      files.push({ name, path:dest, size, type:fileType(name),
        thumbnail:raw.thumbs?.url3||raw.thumbs?.url2||null });
      console.log(`[Terabox][6-sign] ✓ ${name}`);
    } catch (e) { console.error(`[6-sign] "${name}":`, e.message); }
  }

  if (!files.length) return { success:false };
  return { success:true, count:files.length, files, tmpDir };
}

/* ─────────────────────────────────────────────────────────────
   MAIN EXPORT
───────────────────────────────────────────────────────────── */
export async function handleTerabox(url, cookiesPath) {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), "terabox-"));
  const shortCode = extractTeraboxShortUrl(url);
  console.log(`[Terabox] Short code: ${shortCode}`);

  const { str: cookieStr, map: cookieMap } = parseCookieFile(cookiesPath);

  try {
    const { surl, jsToken } = await resolveMeta(shortCode, cookieStr, cookieMap);

    /* ── Method 1: RapidAPI ─────────────────────────────── */
    console.log("\n[Terabox] ── Method 1: RapidAPI");
    const r1 = await methodRapidApi(surl, tmpDir, shortCode);
    if (r1.success) return r1;

    /* ── Method 2: yt-dlp ───────────────────────────────── */
    console.log("\n[Terabox] ── Method 2: yt-dlp");
    const r2 = await methodYtdlp(shortCode, cookiesPath, tmpDir);
    if (r2.success) return r2;

    /* ── Shared file list for methods 3–6 ───────────────── */
    const listResult = await getFileList(surl, cookieStr, jsToken);
    if (!listResult) {
      try { fs.rmSync(tmpDir, { recursive:true, force:true }); } catch {}
      return { success:false, files:[], error:"Could not fetch file list" };
    }

    /* ── Method 3: /api/streaming ───────────────────────── */
    console.log("\n[Terabox] ── Method 3: /api/streaming");
    const r3 = await methodStreaming(surl, cookieStr, jsToken, listResult.list, tmpDir);
    if (r3.success) return r3;

    /* ── Method 4: direct dlink ─────────────────────────── */
    console.log("\n[Terabox] ── Method 4: direct dlink");
    const r4 = await methodDirectDlink(surl, cookieStr, jsToken, listResult, tmpDir);
    if (r4.success) return r4;

    /* ── Method 5: WAP API ───────────────────────────────── */
    console.log("\n[Terabox] ── Method 5: WAP API");
    const r5 = await methodWap(surl, cookieStr, jsToken, tmpDir);
    if (r5.success) return r5;

    /* ── Method 6: sign/timestamp ────────────────────────── */
    console.log("\n[Terabox] ── Method 6: sign/timestamp chain");
    const r6 = await methodSign(surl, cookieStr, jsToken, listResult, tmpDir);
    if (r6.success) return r6;

    /* ── All failed ────────────────────────────────────── */
    try { fs.rmSync(tmpDir, { recursive:true, force:true }); } catch {}
    return {
      success: false, files: [],
      error: [
        "All 6 methods failed.",
        "  1. RapidAPI key set but timed out — try a different Terabox link",
        "  2. Update yt-dlp: yt-dlp -U",
        "  3. Re-export cookies from teraboxapp.com (must be logged in)",
      ].join("\n"),
    };

  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive:true, force:true }); } catch {}
    console.error("[Terabox] Unexpected error:", err.message);
    return { success:false, error:err.message, files:[] };
  }
}
