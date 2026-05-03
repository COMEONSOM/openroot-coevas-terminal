// ======================================================
// INSTAGRAM DOWNLOADER — v3
//
// File naming:
//   Single video/reel : username_instagram_YYYYMMDD_postid.mp4
//   Single photo      : username_instagram_YYYY-MM-DD.jpg
//   Multiple (ZIP)    : username_instagram_YYYY-MM-DD.zip
//     └ inside ZIP    : username_instagram_YYYYMMDD_postid_1.jpg ...
//
// Routing:
//   /p/   carousel/photo → gallery-dl → ZIP if >1 file
//   /reel/ /tv/ video    → yt-dlp    → single file
//   audio mode           → yt-dlp -x → mp3
//
// Key fix: yt-dlp uses %(uploader_id)s_instagram_%(upload_date)s_%(id)s
//   as its output template — filename comes from yt-dlp itself,
//   no manual parsing of stdout needed.
// ======================================================

import { spawn } from "child_process";
import path from "path";
import fs   from "fs";
import os   from "os";
import { sendLog } from "./utils/logStream.js";

/* ======================================================
   HELPERS
====================================================== */
function todayStr() { return new Date().toISOString().slice(0, 10); }

function safeName(v) {
  return String(v || "instagram")
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .trim() || "instagram";
}

// Gallery-dl carousel naming (no post ID available from gallery-dl easily)
function buildCarouselFileName(username, ext, index) {
  const suffix = index !== null ? `_${index}` : "";
  return `${safeName(username)}_instagram_${todayStr()}${suffix}.${ext}`;
}

function safeCleanup(dir) {
  try { fs.rm(dir, { recursive: true, force: true }, () => {}); } catch {}
}

const MEDIA_EXTS = new Set([
  "jpg","jpeg","png","webp","gif",
  "mp4","mkv","mov","webm","m4v","avi",
]);

function isMediaFile(filePath) {
  return MEDIA_EXTS.has(path.extname(filePath).slice(1).toLowerCase());
}

function collectMediaFiles(rootDir) {
  const out = [];
  const walk = dir => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (e.isFile() && isMediaFile(full)) out.push(full);
      }
    } catch {}
  };
  walk(rootDir);
  return out;
}

/* ======================================================
   CREATE ZIP
====================================================== */
async function createZip(files, zipPath) {
  // 1. archiver
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

  // 2. PowerShell (Windows)
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

  // 3. zip (Unix)
  await new Promise((resolve, reject) => {
    const proc = spawn("zip", ["-j", zipPath, ...files], { shell: false });
    proc.on("error", reject);
    proc.on("close", code => code === 0 ? resolve() : reject(new Error(`zip exit ${code}`)));
  });
  return zipPath;
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
   CAROUSEL / PHOTO POSTS → gallery-dl
   File naming inside ZIP:
     username_instagram_YYYY-MM-DD_1.jpg
     username_instagram_YYYY-MM-DD_2.mp4
====================================================== */
function isCarouselUrl(url) {
  const u = (url || "").toLowerCase();
  return u.includes("instagram.com/p/") || u.includes("instagr.am/p/");
}

function downloadCarouselWithGalleryDl(url, cookiesPath, res, app) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-carousel-"));

  const args = [
    "--cookies", cookiesPath,
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "-o", "extractor.instagram.videos=true",
    "-d", tmpDir,
    // gallery-dl native naming — we'll rename after
    "--filename", "{username}_{id}_{num}.{extension}",
    url,
  ];

  sendLog(app, "Instagram: carousel/photo → gallery-dl");

  let proc;
  try {
    proc = spawn("gallery-dl", args, {
      shell: false, windowsHide: true, stdio: ["ignore","pipe","pipe"],
    });
  } catch (err) {
    sendLog(app, "gallery-dl not found. Run: pip install gallery-dl");
    return res.status(500).json({ ok: false, error: "gallery-dl not available" });
  }

  app.locals.currentProc = proc;

  // Detect author from gallery-dl path: .../instagram/USERNAME/file
  let detectedUsername = "";
  const downloadedFiles = [];

  proc.stdout.on("data", chunk => {
    const lines = chunk.toString().split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      sendLog(app, line);
      if (fs.existsSync(line) && isMediaFile(line)) {
        downloadedFiles.push(line);
        if (!detectedUsername) {
          const parts = line.split(path.sep);
          const igIdx = parts.indexOf("instagram");
          if (igIdx !== -1 && parts[igIdx + 1]) detectedUsername = parts[igIdx + 1];
        }
      }
    }
  });

  let stderr = "";
  proc.stderr.on("data", d => { const msg = d.toString(); stderr += msg; sendLog(app, msg); });

  proc.on("close", code => {
    app.locals.currentProc = null;

    (async () => {
      let files = downloadedFiles.length > 0
        ? downloadedFiles
        : collectMediaFiles(tmpDir);

      closeSSE(app);

      if (code !== 0 && files.length === 0) {
        safeCleanup(tmpDir);
        return res.status(500).json({
          ok: false, error: `gallery-dl failed (exit ${code}): ${stderr.slice(0, 300)}`,
        });
      }

      if (files.length === 0) {
        safeCleanup(tmpDir);
        return res.status(404).json({ ok: false, error: "No media found in this post" });
      }

      const username = detectedUsername || "instagram";

      // Rename all files to consistent scheme
      const renamed = files.map((f, i) => {
        const ext     = path.extname(f).slice(1).toLowerCase() || "jpg";
        // Single file → no index; multiple → _1, _2 …
        const newName = files.length === 1
          ? buildCarouselFileName(username, ext, null)
          : buildCarouselFileName(username, ext, i + 1);
        const newPath = path.join(path.dirname(f), newName);
        try { fs.renameSync(f, newPath); return newPath; }
        catch { return f; }
      });

      // ── Single file → direct download ───────────────────
      if (renamed.length === 1) {
        sendLog(app, `→ ${path.basename(renamed[0])}`);
        return res.download(renamed[0], path.basename(renamed[0]), () => safeCleanup(tmpDir));
      }

      // ── Multiple → ZIP ───────────────────────────────────
      const zipName = `${safeName(username)}_instagram_${todayStr()}.zip`;
      const zipPath = path.join(tmpDir, zipName);
      sendLog(app, `${renamed.length} files → ZIP: ${zipName}`);

      try {
        await createZip(renamed, zipPath);
        return res.download(zipPath, zipName, err => {
          if (err) console.warn("ZIP download error:", err.message);
          safeCleanup(tmpDir);
        });
      } catch (zipErr) {
        sendLog(app, `ZIP failed: ${zipErr.message}`);
        safeCleanup(tmpDir);
        return res.status(500).json({ ok: false, error: "ZIP creation failed: " + zipErr.message });
      }
    })().catch(err => {
      console.error("gallery-dl handler error:", err);
      safeCleanup(tmpDir);
      if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
    });
  });

  proc.on("error", err => {
    app.locals.currentProc = null;
    sendLog(app, "gallery-dl error: " + err.message);
    safeCleanup(tmpDir);
    return res.status(500).json({ ok: false, error: "gallery-dl error: " + err.message });
  });
}

/* ======================================================
   REELS / IGTV / VIDEOS → yt-dlp
   ─────────────────────────────────────────────────────
   Output template: %(uploader_id)s_instagram_%(upload_date)s_%(id)s.%(ext)s
   → e.g.  ridhislathia_instagram_20260503_CxABCDE12fg.mp4
   yt-dlp fills these from the post metadata directly —
   no stdout parsing or manual rename needed.
====================================================== */
function downloadVideoWithYtDlp(url, mode, cookiesPath, res, app) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-"));

  // ── Output template: username_instagram_date_postid ──
  // %(uploader)s     = Instagram @username handle (NOT numeric ID)
  // %(uploader_id)s  = numeric user ID — avoid this
  // %(upload_date)s  = YYYYMMDD (yt-dlp format)
  // %(id)s           = post shortcode / ID
  // %(ext)s          = mp4 / mp3 etc.
  // --restrict-filenames replaces spaces/special chars with _
  const outputTemplate = path.join(
    tempDir,
    "%(uploader)s_instagram_%(upload_date)s_%(id)s.%(ext)s"
  );

  const baseArgs = [
    "-3", "-m", "yt_dlp",
    "--no-playlist",
    "--restrict-filenames",
    "--newline",
    "--no-warnings",
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "--add-header", "Referer:https://www.instagram.com/",
    ...(cookiesPath && fs.existsSync(cookiesPath) ? ["--cookies", cookiesPath] : []),
    "-o", outputTemplate,
  ];

  const args = mode === "audio"
    ? [...baseArgs, "-f", "b/best", "-x", "--audio-format", "mp3", "--audio-quality", "0", url]
    : [...baseArgs, "-f", "bv*+ba/best", "--merge-output-format", "mp4", url];

  sendLog(app, mode === "audio"
    ? "Instagram: extracting audio…"
    : "Instagram: downloading reel/video…"
  );

  const proc = spawn("py", args, { shell: false, windowsHide: true });
  app.locals.currentProc = proc;

  proc.stdout.on("data", d => {
    const text = d.toString();
    sendLog(app, text);
    const m = text.match(/(\d{1,3}(?:\.\d+)?)%/);
    if (m && app.locals.progressRes && !app.locals.progressRes.writableEnded)
      app.locals.progressRes.write(`data: ${m[1]}\n\n`);
  });

  proc.stderr.on("data", d => { sendLog(app, d.toString()); });

  proc.on("close", code => {
    app.locals.currentProc = null;

    // Collect output files — exclude .part files
    const files = collectMediaFiles(tempDir).filter(f => !f.endsWith(".part"));

    closeSSE(app);

    if (code !== 0 || files.length === 0) {
      safeCleanup(tempDir);
      sendLog(app, "Instagram download failed.");
      return res.status(500).json({ ok: false, error: "INSTAGRAM_DOWNLOAD_FAILED" });
    }

    // ── Single file (normal case for reels/videos) ───────
    if (files.length === 1) {
      // Filename already correct from yt-dlp template
      sendLog(app, `→ ${path.basename(files[0])}`);
      return res.download(files[0], path.basename(files[0]), () => safeCleanup(tempDir));
    }

    // ── Multiple files → ZIP ─────────────────────────────
    // (rare for reels but handle gracefully)
    // Extract username from first filename: username_instagram_...
    const firstFile = path.basename(files[0]);
    const userFromFile = firstFile.split("_instagram_")[0] || "instagram";
    const zipName = `${safeName(userFromFile)}_instagram_${todayStr()}.zip`;
    const zipPath = path.join(tempDir, zipName);
    sendLog(app, `${files.length} files → ZIP: ${zipName}`);

    createZip(files, zipPath)
      .then(() => res.download(zipPath, zipName, err => {
        if (err) console.warn(err.message);
        safeCleanup(tempDir);
      }))
      .catch(err => {
        sendLog(app, "ZIP failed: " + err.message);
        safeCleanup(tempDir);
        if (!res.headersSent) res.status(500).json({ ok: false, error: "ZIP creation failed" });
      });
  });

  proc.on("error", err => {
    app.locals.currentProc = null;
    sendLog(app, "yt-dlp error: " + err.message);
    safeCleanup(tempDir);
    return res.status(500).json({ ok: false, error: "yt-dlp error: " + err.message });
  });
}

/* ======================================================
   MAIN EXPORT
====================================================== */
export function downloadInstagram({ url, mode = "video" }, res, app, cookiesPath) {
  if (!cookiesPath || !fs.existsSync(cookiesPath))
    sendLog(app, "cookies.txt missing — private content may fail");

  if (isCarouselUrl(url)) {
    sendLog(app, "Detected carousel/photo post → gallery-dl");
    return downloadCarouselWithGalleryDl(url, cookiesPath, res, app);
  }

  return downloadVideoWithYtDlp(url, mode, cookiesPath, res, app);
}