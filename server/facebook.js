// ======================================================
// FACEBOOK DOWNLOADER (SMART MODE READY)
// - video → yt-dlp → single file stream
// - audio → yt-dlp -x → mp3 stream
// - No carousel: Facebook posts are video-only
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
      if (err) console.warn("FB cleanup failed:", err.message);
    });
  } catch (e) {
    console.warn("FB cleanup exception:", e.message);
  }
}

/* ======================================================
   MAIN EXPORT
====================================================== */
export function downloadFacebook({ url, mode = "video" }, res, app, cookiesPath) {

  if (!cookiesPath || !fs.existsSync(cookiesPath)) {
    sendLog(app, "cookies.txt missing — private content may fail");
  }

  const tempDir        = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
  const outputTemplate = path.join(tempDir, "facebook_%(id)s.%(ext)s");

  const baseArgs = [
    "-3", "-m", "yt_dlp",
    "--no-playlist",
    "--restrict-filenames",
    ...(cookiesPath && fs.existsSync(cookiesPath)
      ? ["--cookies", cookiesPath]
      : []),
    "-o", outputTemplate
  ];

  let args;

  /* ======================================================
     MODE HANDLING
  ====================================================== */

  if (mode === "audio") {
    args = [
      ...baseArgs,
      "-f", "b/best",
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      url
    ];
    sendLog(app, "Facebook: Extracting MP3...");
  } else {
    // video (default) — Facebook has no photo-only carousel
    args = [
      ...baseArgs,
      "-f", "bv*+ba/best",
      "--merge-output-format", "mp4",
      url
    ];
    sendLog(app, "Facebook: Downloading video...");
  }

  console.log("▶ FB yt-dlp:", args.join(" "));

  const proc = spawn("py", args, {
    shell: false,
    windowsHide: true
  });

  app.locals.currentProc = proc;

  /* ======================================================
     PROGRESS
  ====================================================== */

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

  /* ======================================================
     ON COMPLETE
  ====================================================== */

  proc.on("close", (code) => {
    app.locals.currentProc = null;

    let files = [];
    try {
      files = fs.readdirSync(tempDir).filter(f => !f.endsWith(".part"));
    } catch {}

    // ── Finish SSE streams ──────────────────────────────
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
      sendLog(app, "Facebook download failed.");
      return res.status(500).json({ ok: false, error: "FACEBOOK_DOWNLOAD_FAILED" });
    }

    // ── Single file send ────────────────────────────────
    // Facebook yt-dlp always produces one merged mp4/mp3
    const filePath = path.join(tempDir, files[0]);

    res.download(filePath, files[0], (err) => {
      if (err) console.warn("FB res.download error:", err.message);
      safeCleanup(tempDir);
    });
  });

  proc.on("error", (err) => {
    app.locals.currentProc = null;
    console.error("FB yt-dlp process error:", err);
    sendLog(app, "yt-dlp error: " + err.message);
    safeCleanup(tempDir);
    return res.status(500).json({ ok: false, error: "yt-dlp process error: " + err.message });
  });
}
