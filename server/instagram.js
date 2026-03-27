// ======================================================
// INSTAGRAM DOWNLOADER (SMART MODE - gallery-dl + yt-dlp)
// - /p/ carousel/photos  → gallery-dl → JSON file list
// - /reel/ /tv/ video    → yt-dlp    → single file stream
// - audio mode           → yt-dlp -x → mp3 stream
// ======================================================

import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { sendLog } from "./utils/logStream.js";

/* ======================================================
   SAFE CLEANUP
====================================================== */
function safeCleanup(dir) {
  try {
    fs.rm(dir, { recursive: true, force: true }, (err) => {
      if (err) console.warn("Cleanup failed:", err.message);
    });
  } catch (e) {
    console.warn("Cleanup exception:", e.message);
  }
}

/* ======================================================
   CAROUSEL DETECTOR
====================================================== */
function isCarouselUrl(url) {
  const u = (url || "").toLowerCase();
  return u.includes("instagram.com/p/") || u.includes("instagr.am/p/");
}

/* ======================================================
   GALLERY-DL: CAROUSEL / PHOTO POSTS
   Returns JSON: { ok, type:"carousel", count, files[], tmpDir }
   Frontend app.js handleCarouselResponse() + GET /serve handles delivery.
====================================================== */
function downloadCarouselWithGalleryDl(url, cookiesPath, res, app) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-carousel-"));

  const args = [
    "--cookies", cookiesPath,
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    // Pass inline option to also grab videos inside carousels
    "-o", "extractor.instagram.videos=true",
    "-d", tmpDir,
    "--filename", "{username}_{id}_{num}.{extension}",
    url
  ];

  sendLog(app, `Instagram carousel → gallery-dl`);
  sendLog(app, `Temp: ${tmpDir}`);
  console.log("▶ gallery-dl carousel:", url);

  let stderr = "";
  let proc;

  try {
    proc = spawn("gallery-dl", args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (err) {
    console.error("gallery-dl spawn failed:", err);
    sendLog(app, "gallery-dl not found. Run: pip install gallery-dl");
    return res.status(500).json({
      ok: false,
      error: "gallery-dl not available. Install: pip install gallery-dl"
    });
  }

  app.locals.currentProc = proc;

  // gallery-dl prints downloaded file paths to stdout (one per line)
  const downloadedFiles = [];

  proc.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      sendLog(app, line);
      if (fs.existsSync(line)) {
        downloadedFiles.push(line);
      }
    }
  });

  proc.stderr.on("data", (d) => {
    const msg = d.toString();
    stderr += msg;
    sendLog(app, "oops!" + msg);
  });

  proc.on("close", (code) => {
    app.locals.currentProc = null;

    // ── Fallback: scan tmpDir if stdout didn't capture paths ──────
    let files = downloadedFiles;

    if (files.length === 0) {
      try {
        files = fs.readdirSync(tmpDir)
          .flatMap(entry => {
            const full = path.join(tmpDir, entry);
            if (fs.statSync(full).isDirectory()) {
              return fs.readdirSync(full).map(f => path.join(full, f));
            }
            return [full];
          })
          .filter(f => fs.statSync(f).isFile());
      } catch {}
    }

    // ── Finish SSE streams ────────────────────────────────────────
    if (app.locals.progressRes) {
      app.locals.progressRes.write("data: 100\n\n");
      app.locals.progressRes.end();
      app.locals.progressRes = null;
    }
    if (app.locals.logRes) {
      app.locals.logRes.end();
      app.locals.logRes = null;
    }

    if (code !== 0 && files.length === 0) {
      console.error("gallery-dl failed (code", code, "):", stderr);
      sendLog(app, `gallery-dl failed (exit ${code})`);
      safeCleanup(tmpDir);
      return res.status(500).json({
        ok: false,
        error: `gallery-dl failed (exit ${code}): ${stderr.slice(0, 300)}`
      });
    }

    if (files.length === 0) {
      sendLog(app, "No media found in post");
      safeCleanup(tmpDir);
      return res.status(404).json({
        ok: false,
        error: "No media files found in carousel post"
      });
    }

    sendLog(app, `gallery-dl: ${files.length} file(s) ready`);
    console.log(`gallery-dl: ${files.length} file(s) in ${tmpDir}`);

    // Return file list — frontend fetches each via GET /serve?file=...
    return res.json({
      ok: true,
      type: "carousel",
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
    app.locals.currentProc = null;
    console.error("gallery-dl process error:", err);
    sendLog(app, "gallery-dl error: " + err.message);
    safeCleanup(tmpDir);
    return res.status(500).json({
      ok: false,
      error: "gallery-dl process error: " + err.message
    });
  });
}

/* ======================================================
   YT-DLP: REELS / IGTV / VIDEOS (single file)
====================================================== */
function downloadVideoWithYtDlp(url, mode, cookiesPath, res, app) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-"));
  const outputTemplate = path.join(tempDir, "instagram_%(id)s.%(ext)s");

  const baseArgs = [
    "-3", "-m", "yt_dlp",
    "--no-playlist",
    "--restrict-filenames",
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "--add-header", "Referer:https://www.instagram.com/",
    ...(cookiesPath && fs.existsSync(cookiesPath)
      ? ["--cookies", cookiesPath]
      : []),
    "-o", outputTemplate
  ];

  let args;

  if (mode === "audio") {
    args = [
      ...baseArgs,
      "-f", "b/best",
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      url
    ];
    sendLog(app, "Instagram: Extracting MP3...");
  } else {
    args = [
      ...baseArgs,
      "-f", "bv*+ba/best",
      "--merge-output-format", "mp4",
      url
    ];
    sendLog(app, "Instagram: Downloading reel/video...");
  }

  console.log("▶ IG yt-dlp (reel/video):", args.join(" "));

  const proc = spawn("py", args, {
    shell: false,
    windowsHide: true
  });

  app.locals.currentProc = proc;

  proc.stdout.on("data", (d) => {
    const text = d.toString();
    sendLog(app, text);
    const match = text.match(/(\d{1,3}(?:\.\d+)?)%/);
    if (match && app.locals.progressRes) {
      app.locals.progressRes.write(`data: ${match[1]}\n\n`);
    }
  });

  proc.stderr.on("data", (d) => {
    sendLog(app, "oops!" + d.toString());
  });

  proc.on("close", (code) => {
    app.locals.currentProc = null;

    let files = [];
    try {
      files = fs.readdirSync(tempDir).filter(f => !f.endsWith(".part"));
    } catch {}

    // ── Finish SSE streams ──────────────────────────────────────
    if (app.locals.progressRes) {
      app.locals.progressRes.write("data: 100\n\n");
      app.locals.progressRes.end();
      app.locals.progressRes = null;
    }
    if (app.locals.logRes) {
      app.locals.logRes.end();
      app.locals.logRes = null;
    }

    if (code !== 0 || files.length === 0) {
      safeCleanup(tempDir);
      sendLog(app, "Instagram download failed.");
      return res.status(500).json({ ok: false, error: "INSTAGRAM_DOWNLOAD_FAILED" });
    }

    // Send single file
    const filePath = path.join(tempDir, files[0]);
    res.download(filePath, files[0], () => {
      safeCleanup(tempDir);
    });
  });

  proc.on("error", (err) => {
    app.locals.currentProc = null;
    sendLog(app, "yt-dlp error: " + err.message);
    safeCleanup(tempDir);
    return res.status(500).json({ ok: false, error: "yt-dlp process error: " + err.message });
  });
}

/* ======================================================
   MAIN EXPORT
====================================================== */
export function downloadInstagram({ url, mode = "video" }, res, app, cookiesPath) {

  if (!cookiesPath || !fs.existsSync(cookiesPath)) {
    sendLog(app, "cookies.txt missing — private content may fail");
  }

  // ── Route: carousel/photo post → gallery-dl ──────────────────
  if (isCarouselUrl(url)) {
    sendLog(app, "Detected carousel/photo post → using gallery-dl");
    return downloadCarouselWithGalleryDl(url, cookiesPath, res, app);
  }

  // ── Route: reel/video/audio → yt-dlp ─────────────────────────
  return downloadVideoWithYtDlp(url, mode, cookiesPath, res, app);
}
