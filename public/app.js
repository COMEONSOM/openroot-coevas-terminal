// =====================================================
// COEVAS CONTROL SURFACE — app.js
// PRODUCTION BUILD — All platforms + full error handling
// =====================================================


const btn              = document.getElementById("download");
const cancelBtn        = document.getElementById("cancel");
const status           = document.getElementById("status");

const progress         = document.getElementById("progress");
const bar              = document.getElementById("bar");
const percentText      = document.getElementById("percent");

const logsBox          = document.getElementById("logs");
const fileInfo         = document.getElementById("fileInfo");

const fileResolution   = document.getElementById("fileResolution");
const fileSize         = document.getElementById("fileSize");
const codecBadge       = document.getElementById("codecBadge");

const urlInput         = document.getElementById("url");
const qualitySelect    = document.getElementById("quality");
const maxQualityToggle = document.getElementById("maxQuality");

const modeSelect       = document.getElementById("mode");
const platformIcon     = document.getElementById("platformIcon");
const platformText     = document.getElementById("platformText");
const carouselNote     = document.getElementById("carouselNote");

let logSource          = null;
let progressSource     = null;
let isRunning          = false;
let sourceInfo         = null;
let probeDebounceTimer = null;

const qualityRow    = qualitySelect?.closest(".field")  || qualitySelect?.parentElement;
const av1ToggleWrap = maxQualityToggle?.closest(".toggle") || maxQualityToggle?.parentElement;


/* =====================================================
   PLATFORM DETECT
===================================================== */
function detectPlatform(url) {
  const u = (url || "").toLowerCase();

  if (u.includes("youtube.com")   || u.includes("youtu.be"))
    return { name: "YouTube",   icon: "/icons/youtube.svg",   type: "youtube" };

  if (u.includes("facebook.com")  || u.includes("fb.watch"))
    return { name: "Facebook",  icon: "/icons/facebook.svg",  type: "meta" };

  if (u.includes("instagram.com") || u.includes("instagr.am"))
    return { name: "Instagram", icon: "/icons/instagram.svg", type: "meta" };

  if (u.includes("threads.net")   || u.includes("threads.com"))
    return { name: "Threads",   icon: "/icons/threads.svg",   type: "meta" };

  // ✅ matches all Terabox domains — same order as server.js
  if (
    u.includes("teraboxapp.com") ||
    u.includes("terabox.app")    ||
    u.includes("terabox.com")    ||
    u.includes("1024tera.com")
  )
    return { name: "Terabox", icon: "/icons/terabox.svg", type: "terabox" };

  return { name: "Paste a link", icon: "/icons/default.svg", type: "unknown" };
}


/* =====================================================
   META TYPE DETECT
===================================================== */
function detectMetaType(url) {
  const u = (url || "").toLowerCase();
  if (u.includes("/reel/") || u.includes("/video/") || u.includes("/tv/")) return "video";
  if (u.includes("/p/"))    return "carousel";
  if (u.includes("/post/")) return isThreadsUrl(url) ? "carousel" : "video";
  return "unknown";
}


/* =====================================================
   IS THREADS?
===================================================== */
function isThreadsUrl(url) {
  const u = (url || "").toLowerCase();
  return u.includes("threads.net") || u.includes("threads.com");
}


/* =====================================================
   MODE DROPDOWN CONTROL
===================================================== */
function updateModeOptions() {
  if (!modeSelect) return;

  const url      = urlInput.value.trim();
  const { type } = detectPlatform(url);

  for (const opt of modeSelect.options) {
    opt.disabled      = false;
    opt.style.opacity = "1";
  }

  // Terabox treated like YouTube — no carousel mode
  if (type === "youtube" || type === "terabox") {
    for (const opt of modeSelect.options) {
      if (opt.value === "carousel") {
        opt.disabled      = true;
        opt.style.opacity = "0.4";
      }
    }
    if (modeSelect.value === "carousel") modeSelect.value = "video";
    return;
  }

  if (type === "meta") {
    const metaType = detectMetaType(url);

    if (metaType === "video") {
      for (const opt of modeSelect.options) {
        if (opt.value === "carousel") {
          opt.disabled      = true;
          opt.style.opacity = "0.4";
        }
      }
      if (modeSelect.value === "carousel") modeSelect.value = "video";
      return;
    }

    if (metaType === "carousel") {
      for (const opt of modeSelect.options) {
        if (opt.value === "video" || opt.value === "audio") {
          opt.disabled      = true;
          opt.style.opacity = "0.4";
        }
      }
      modeSelect.value = "carousel";
      return;
    }

    if (modeSelect.value === "carousel") modeSelect.value = "video";
  }
}


/* =====================================================
   AUDIO / VIDEO UI SYNC — reflects selected quality
===================================================== */
function syncModeUI() {
  const mode    = modeSelect?.value || "video";
  const isAudio = mode === "audio";

  if (isAudio) {
    if (qualityRow)    qualityRow.style.display    = "none";
    if (av1ToggleWrap) av1ToggleWrap.style.display = "none";

    if (fileResolution) fileResolution.textContent = "Audio only";
    applyCodecBadge("MP3");

    if (fileSize) {
      const videoSize = sourceInfo?.sizeByHeight?.[sourceInfo?.maxHeight];
      fileSize.textContent = videoSize ? formatBytes(Math.round(videoSize * 0.12)) : "Auto";
    }

  } else {
    if (qualityRow)    qualityRow.style.display    = "";
    if (av1ToggleWrap) av1ToggleWrap.style.display = "";

    if (sourceInfo?.platform === "youtube") {
      const selectedVal = qualitySelect?.value || "best";

      let displayHeight, displayCodec;

      if (selectedVal.startsWith("h264-")) {
        displayHeight = parseInt(selectedVal.replace("h264-", ""), 10);
        displayCodec  = "H.264";

      } else if (selectedVal === "best" || !selectedVal) {
        displayHeight = sourceInfo.maxHeight;
        displayCodec  = maxQualityToggle?.checked
          ? (sourceInfo.bestCodecAV1 || sourceInfo.bestCodec || "AV1")
          : (sourceInfo.bestCodec    || sourceInfo.codec     || "H.264");

      } else {
        displayHeight = parseInt(selectedVal, 10);
        displayCodec  = maxQualityToggle?.checked
          ? (sourceInfo.bestCodecAV1 || "AV1")
          : (sourceInfo.codecByHeight?.[displayHeight] || sourceInfo.codec || "H.264");
      }

      if (fileResolution) fileResolution.textContent = displayHeight ? `${displayHeight}p` : "—";
      applyCodecBadge(displayCodec);
      if (fileSize) fileSize.textContent = formatBytes(sourceInfo.sizeByHeight?.[displayHeight]);

    } else if (sourceInfo?.type === "carousel") {
      if (fileResolution) fileResolution.textContent = "Auto (All media)";
      applyCodecBadge("gallery-dl");
      if (fileSize) fileSize.textContent = "Auto";

    } else if (sourceInfo?.platform === "terabox") {
      if (fileResolution) fileResolution.textContent = "Auto (Server provides)";
      applyCodecBadge(sourceInfo.codec || "Auto");
      if (fileSize) fileSize.textContent = sourceInfo.size || "Auto";

    } else if (sourceInfo) {
      if (fileResolution) fileResolution.textContent = "Auto (Highest)";
      applyCodecBadge(sourceInfo.codec || "Auto");
      if (fileSize) fileSize.textContent = sourceInfo.size || "Auto";
    }
  }
}


/* =====================================================
   UI HELPERS
===================================================== */
function updatePlatformBadge() {
  const { name, icon } = detectPlatform(urlInput.value);
  if (platformIcon) platformIcon.src         = icon;
  if (platformText) platformText.textContent = name;
}

function setStatus(msg, type = "info") {
  if (!status) return;
  status.textContent = msg;
  status.style.color =
    type === "error"   ? "#fca5a5" :
    type === "success" ? "#86efac" :
    "#c7d2fe";
}

function disableDownload(disabled, reason = "") {
  if (!btn) return;
  btn.disabled      = disabled;
  btn.style.opacity = disabled ? "0.6" : "1";
  btn.style.cursor  = disabled ? "not-allowed" : "pointer";
  if (disabled && reason) setStatus(reason, "info");
}

function resetUI() {
  isRunning = false;
  if (btn)       btn.style.display        = "block";
  if (progress)  progress.style.display   = "none";
  if (cancelBtn) cancelBtn.style.display  = "none";

  if (progressSource) { progressSource.close(); progressSource = null; }
  if (logSource)      { logSource.close();      logSource      = null; }
}

function appendLog(line) {
  if (!logsBox) return;
  logsBox.textContent += line + "\n";
  logsBox.scrollTop    = logsBox.scrollHeight;
}


/* =====================================================
   FORMAT BYTES
===================================================== */
function formatBytes(bytes) {
  if (!bytes || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(2)} ${units[i]}`;
}


/* =====================================================
   FILENAME FROM CONTENT-DISPOSITION
===================================================== */
function getFilenameFromResponse(response, fallback = "download") {
  try {
    const cd = response.headers.get("Content-Disposition") || "";
    if (!cd) return fallback;
    const utf8  = cd.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8)   return decodeURIComponent(utf8[1].trim());
    const plain = cd.match(/filename="?([^";]+)"?/i);
    if (plain)  return plain[1].trim();
  } catch {}
  return fallback;
}


/* =====================================================
   CODEC BADGE
===================================================== */
function applyCodecBadge(label) {
  if (!codecBadge) return;
  codecBadge.textContent = label || "Auto";
  codecBadge.className   = "codec-badge " + (
    label === "AV1"        ? "av1"     :
    label === "VP9"        ? "vp9"     :
    label === "H.264"      ? "h264"    :
    label === "MP3"        ? "h264"    :
    label === "gallery-dl" ? "gallery" :
    "h264"
  );
}


/* =====================================================
   CAROUSEL NOTE
===================================================== */
function showCarouselNote(msg) {
  if (!carouselNote) return;
  carouselNote.textContent   = msg;
  carouselNote.style.display = "block";
}

function hideCarouselNote() {
  if (!carouselNote) return;
  carouselNote.style.display = "none";
}


/* =====================================================
   INPUT HANDLER — debounced probe
===================================================== */
urlInput.addEventListener("input", () => {
  updatePlatformBadge();
  updateModeOptions();

  if (fileInfo) fileInfo.style.display = "none";
  hideCarouselNote();

  const url = urlInput.value.trim();

  if (!url) {
    sourceInfo = null;
    disableDownload(true, "Paste a link");
    return;
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    disableDownload(true);
    setStatus("URL must start with https://", "error");
    return;
  }

  clearTimeout(probeDebounceTimer);
  disableDownload(true);
  setStatus("Waiting…", "info");
  probeDebounceTimer = setTimeout(() => probeSource(url), 500);
});


/* =====================================================
   MODE CHANGE HANDLER
===================================================== */
if (modeSelect) {
  modeSelect.addEventListener("change", () => {
    updateModeOptions();
    if (sourceInfo && fileInfo?.style.display !== "none") {
      syncModeUI();
    }
  });
}


/* =====================================================
   QUALITY CHANGE HANDLER — updates file info card
===================================================== */
if (qualitySelect) {
  qualitySelect.addEventListener("change", () => {
    if (!sourceInfo || modeSelect?.value === "audio") return;
    syncModeUI();
  });
}


/* =====================================================
   AV1 TOGGLE HANDLER — updates codec badge
===================================================== */
if (maxQualityToggle) {
  maxQualityToggle.addEventListener("change", () => {
    if (!sourceInfo || modeSelect?.value !== "video") return;
    const selectedVal = qualitySelect?.value || "best";
    if (!selectedVal.startsWith("h264-")) {
      syncModeUI();
    }
  });
}


/* =====================================================
   SOURCE PROBE
===================================================== */
async function probeSource(url) {
  sourceInfo = null;
  if (fileInfo) fileInfo.style.display = "none";
  hideCarouselNote();
  disableDownload(true);
  setStatus("Analyzing…", "info");

  const { type } = detectPlatform(url);

  if (type === "unknown") {
    setStatus("Unsupported platform — YouTube, Instagram, Facebook, Threads, Terabox only", "error");
    disableDownload(true);
    return;
  }

  let data;
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 20000);

    const res = await fetch("/info", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url }),
      signal:  controller.signal
    });

    clearTimeout(timeout);
    data = await res.json().catch(() => null);

    if (!res.ok || !data || data.ok === false) {
      throw new Error(data?.error || `Server error ${res.status}`);
    }

  } catch (err) {
    if (err.name === "AbortError") {
      setStatus("Probe timed out — server may be busy", "error");
    } else {
      setStatus(`${err.message}`, "error");
    }
    disableDownload(true);
    return;
  }

  sourceInfo = data;

  // ── YouTube ──────────────────────────────────────────
  if (type === "youtube") {
    if (qualitySelect) {
      qualitySelect.disabled      = false;
      qualitySelect.style.opacity = "1";
    }

    const maxH  = data.maxHeight;
    const codec = data.bestCodec || data.codec || "H.264";

    if (fileResolution) fileResolution.textContent = maxH ? `${maxH}p` : "—";
    applyCodecBadge(codec);
    if (fileSize) fileSize.textContent = formatBytes(data.sizeByHeight?.[maxH]);

    if (qualitySelect && data.availableHeights?.length) {
      qualitySelect.innerHTML = "";

      const bestOpt = document.createElement("option");
      bestOpt.value = "best";
      bestOpt.text  = `Best (${maxH}p · ${codec})`;
      qualitySelect.appendChild(bestOpt);

      for (const h of [...data.availableHeights].reverse()) {
        if (h === maxH) continue;
        const opt = document.createElement("option");
        opt.value = String(h);
        opt.text  = `${h}p`;
        qualitySelect.appendChild(opt);
      }

      if (data.h264Heights?.length) {
        const sep    = document.createElement("option");
        sep.disabled = true;
        sep.text     = "── H.264 Compat ──";
        qualitySelect.appendChild(sep);

        for (const h of [...data.h264Heights].reverse()) {
          const opt = document.createElement("option");
          opt.value = `h264-${h}`;
          opt.text  = `${h}p · H.264`;
          qualitySelect.appendChild(opt);
        }
      }

      qualitySelect.value = "best";
    }

  // ── Meta (Instagram / Facebook / Threads) ────────────
  } else if (type === "meta") {
    if (qualitySelect) {
      qualitySelect.disabled      = true;
      qualitySelect.style.opacity = "0.5";
    }

    const isCarousel = data.type === "carousel";
    const isThreads  = isThreadsUrl(url);

    if (isCarousel) {
      if (fileResolution) fileResolution.textContent = "Auto (All media)";
      applyCodecBadge("gallery-dl");
      if (fileSize) fileSize.textContent = "Auto";

      const platform = isThreads ? "Threads" : "Instagram";
      showCarouselNote(`${platform} post — all photos & videos will be downloaded`);

      if (modeSelect) modeSelect.value = "carousel";

    } else {
      if (fileResolution) fileResolution.textContent = "Auto (Highest)";
      applyCodecBadge(data.codec || "Auto");
      if (fileSize) fileSize.textContent = data.size || "Auto";

      if (isThreads) {
        showCarouselNote("Threads post — video or images will be auto-detected");
      }
    }

  // ── Terabox ──────────────────────────────────────────
  } else if (type === "terabox") {
    if (qualitySelect) {
      qualitySelect.disabled      = true;
      qualitySelect.style.opacity = "0.5";
    }

    if (fileResolution) fileResolution.textContent = "Auto (Server provides)";
    applyCodecBadge(data.codec || "Auto");
    if (fileSize) fileSize.textContent = data.size || "Auto";
  }

  const noteMsg = data.note ? `${data.note}` : "Analyzed";
  setStatus(noteMsg, "success");

  if (fileInfo) fileInfo.style.display = "block";

  syncModeUI();
  disableDownload(false);
}


/* =====================================================
   SSE: LOGS
===================================================== */
function startLogs() {
  if (logSource) { logSource.close(); logSource = null; }

  if (logsBox) {
    logsBox.style.display = "block";
    logsBox.textContent   = "";
  }

  logSource = new EventSource("/logs");

  logSource.onopen = () => appendLog("— log stream connected —");

  logSource.onmessage = (e) => {
    const line = (e.data || "").replace(/\\n/g, "\n");
    appendLog(line);
  };

  logSource.onerror = () => {
    if (logSource?.readyState === EventSource.CLOSED) {
      appendLog("— log stream closed —");
    }
  };
}


/* =====================================================
   SSE: PROGRESS
===================================================== */
function openProgress() {
  if (progressSource) { progressSource.close(); progressSource = null; }

  if (progress)    progress.style.display     = "block";
  if (bar)         bar.style.width            = "0%";
  if (percentText) percentText.textContent    = "0%";

  progressSource = new EventSource("/progress");

  progressSource.onmessage = (e) => {
    const p = Number(e.data);
    if (!isNaN(p) && p >= 0) {
      if (bar)         bar.style.width         = `${p}%`;
      if (percentText) percentText.textContent = `${Math.round(p)}%`;
    }
  };

  progressSource.onerror = () => {};
}


/* =====================================================
   CAROUSEL / MULTI-FILE DOWNLOAD HANDLER
   Used for: Instagram carousel, Threads, Terabox files
===================================================== */
async function handleCarouselResponse(data) {
  if (!data.files || data.files.length === 0) {
    throw new Error("No files returned from server");
  }

  const total = data.files.length;
  setStatus(`${total} file(s) ready — saving…`, "info");

  let saved  = 0;
  let failed = 0;

  for (let i = 0; i < total; i++) {
    const f   = data.files[i];
    const url = `/serve?file=${encodeURIComponent(f.path)}`;

    setStatus(`Saving ${i + 1}/${total}: ${f.name}`, "info");

    try {
      const r = await fetch(url);

      if (!r.ok) {
        console.warn(`/serve failed for ${f.name}: HTTP ${r.status}`);
        failed++;
        continue;
      }

      const blob = await r.blob();
      if (blob.size === 0) {
        console.warn(`Empty file: ${f.name}`);
        failed++;
        continue;
      }

      const a    = document.createElement("a");
      a.href     = URL.createObjectURL(blob);
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);

      saved++;

      if (i < total - 1) await new Promise(r => setTimeout(r, 700));

    } catch (err) {
      console.error(`File error: ${f.name}`, err);
      failed++;
    }
  }

  if (saved === 0) {
    throw new Error(`All ${total} files failed to download`);
  }

  const msg = failed > 0
    ? `${saved}/${total} downloaded (${failed} failed)`
    : `${total} file(s) downloaded`;

  setStatus(msg, failed > 0 ? "info" : "success");
}


/* =====================================================
   CANCEL
===================================================== */
if (cancelBtn) {
  cancelBtn.onclick = async () => {
    try {
      await fetch("/cancel", { method: "POST" });
    } catch (e) {
      console.warn("Cancel fetch failed:", e.message);
    }
    setStatus("Download canceled", "info");
    resetUI();
  };
}


/* =====================================================
   DOWNLOAD
===================================================== */
btn.onclick = async () => {
  if (isRunning || btn.disabled) return;

  const url      = urlInput.value.trim();
  const quality  = qualitySelect?.value      || "best";
  const allowAV1 = maxQualityToggle?.checked || false;
  const mode     = modeSelect?.value         || "video";

  if (!url) {
    setStatus("Enter a valid URL", "error");
    return;
  }

  const { type } = detectPlatform(url);
  if (type === "unknown") {
    setStatus("Unsupported platform", "error");
    return;
  }

  isRunning = true;
  if (btn)       btn.style.display        = "none";
  if (cancelBtn) cancelBtn.style.display  = "block";

  const isCarousel = mode === "carousel";

  startLogs();
  if (!isCarousel) openProgress();

  setStatus(isCarousel ? "Downloading…" : "⬇ Starting download…", "info");

  await new Promise(r => setTimeout(r, 350));

  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 30 * 60 * 1000);

    let res;
    try {
      res = await fetch("/download", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ url, quality, allowAV1, mode }),
        signal:  controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      let errMsg = `Server error ${res.status}`;
      try {
        const errData = await res.json();
        errMsg = errData?.error || errMsg;
      } catch {}
      throw new Error(errMsg);
    }

    const contentType = res.headers.get("Content-Type") || "";
    const isJsonResp  = contentType.includes("application/json");

    if (isJsonResp) {
      const data = await res.json();

      if (!data.ok) throw new Error(data.error || "Download failed");

      // Instagram / Threads carousel
      if (data.type === "carousel" && data.files) {
        setStatus(`${data.count} media file(s) found`, "info");
        await handleCarouselResponse(data);

      // Terabox + any multi-file response
      } else if (data.type === "files" && data.files) {
        setStatus(`${data.count} file(s) found`, "info");
        await handleCarouselResponse(data);

      } else {
        throw new Error(data.error || "Unexpected JSON response");
      }

    } else {
      // Binary stream (YouTube / Facebook / Instagram single)
      const ct  = res.headers.get("Content-Type") || "";
      const ext = mode === "audio"
        ? "mp3"
        : ct.includes("webm") ? "webm" : "mp4";

      const filename = getFilenameFromResponse(res, `download.${ext}`);

      setStatus("⬇ Downloading…", "info");

      const blob = await res.blob();

      if (blob.size === 0) {
        throw new Error("Received empty file — post may be private or unavailable");
      }

      const a    = document.createElement("a");
      a.href     = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 15000);

      setStatus("Download complete ✓", "success");
    }

  } catch (err) {
    if (err.name === "AbortError") {
      setStatus("Request timed out", "error");
    } else {
      setStatus("oops! " + (err.message || "Download failed"), "error");
    }
    console.error("Download error:", err);

  } finally {
    resetUI();
  }
};


/* =====================================================
   INIT
===================================================== */
disableDownload(true, "Paste a link");
updatePlatformBadge();