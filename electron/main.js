import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import dotenv from "dotenv";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ─── Load environment variables ───────────────────────────── */
dotenv.config({
  path: path.join(__dirname, "../server/.env"),
});

// dev  → port 3000  (npm start, reads source files)
// prod → port 39281 (built .exe, reads frozen resources)
const IS_DEV = !app.isPackaged;
const APP_PORT = IS_DEV ? 3000 : 39281;

const CURRENT_VERSION = app.getVersion();
const GITHUB_OWNER = process.env.GITHUB_OWNER || "COMEONSOM";
const GITHUB_REPO = process.env.GITHUB_REPO || "openroot-web";
const UPDATE_MANIFEST_URL = (process.env.COEVAS_UPDATE_MANIFEST_URL || "").trim();
const RELEASES_PAGE_URL =
  (process.env.COEVAS_RELEASES_PAGE_URL || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`).trim();
const UPDATE_FETCH_TIMEOUT_MS = Number(process.env.COEVAS_UPDATE_TIMEOUT_MS) || 6000;

const COOKIE_STATE_FILENAME = "cookie_state.json";

let embeddedServer = null;
let stopEmbeddedServer = null;
let updateWindow = null;
let appQuitting = false;

/* ─── App icon path ────────────────────────────────────────── */
function getAppIconPath() {
  const candidates = [
    path.join(__dirname, "../public/assets/company-icon.png"),
    path.join(process.resourcesPath, "public/assets/company-icon.png"),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

/* ─── Small helpers ────────────────────────────────────────── */
function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseVersionPart(part) {
  const match = String(part ?? "").match(/\d+/);
  return match ? Number.parseInt(match[0], 10) : 0;
}

function compareVersions(a = "0.0.0", b = "0.0.0") {
  const pa = String(a).split(".").map(parseVersionPart);
  const pb = String(b).split(".").map(parseVersionPart);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

async function fetchJsonWithTimeout(url, timeoutMs = UPDATE_FETCH_TIMEOUT_MS) {
  if (!url) return null;
  if (typeof fetch !== "function") return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
    });

    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.warn("[Update] manifest fetch failed:", err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUpdateManifest(raw) {
  if (!raw || typeof raw !== "object") return null;

  const latestVersion = String(raw.latestVersion || raw.version || "").trim();
  const minimumRequiredVersion = String(
    raw.minimumRequiredVersion || raw.minVersion || raw.requiredVersion || latestVersion
  ).trim();

  if (!latestVersion) return null;

  return {
    latestVersion,
    minimumRequiredVersion,
    downloadUrl: String(raw.downloadUrl || raw.url || RELEASES_PAGE_URL).trim(),
    notes: String(raw.notes || raw.description || "").trim(),
    title: String(raw.title || `Update required — v${latestVersion}`).trim(),
    forceUpdate: Boolean(raw.forceUpdate ?? raw.required ?? true),
  };
}

async function checkForcedUpdateGate() {
  if (!UPDATE_MANIFEST_URL) {
    console.warn("[Update] COEVAS_UPDATE_MANIFEST_URL not set — skipping gate.");
    return { required: false, manifest: null, reason: "manifest-url-missing" };
  }

  const raw = await fetchJsonWithTimeout(UPDATE_MANIFEST_URL);
  const manifest = normalizeUpdateManifest(raw);

  if (!manifest) {
    console.warn("[Update] Invalid or unavailable update manifest.");
    return { required: false, manifest: null, reason: "manifest-invalid" };
  }

  const minimum = manifest.minimumRequiredVersion || manifest.latestVersion;
  const required = compareVersions(CURRENT_VERSION, minimum) < 0;

  return {
    required,
    manifest,
    reason: required ? "forced-update" : "up-to-date",
  };
}

/* ─── Forced-update window ────────────────────────────────────── */
function createForceUpdateWindow(manifest) {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.focus();
    return updateWindow;
  }

  const latestVersion = manifest?.latestVersion || "unknown";
  const downloadUrl = manifest?.downloadUrl || RELEASES_PAGE_URL;
  const notes = manifest?.notes || "A newer version is required to continue.";
  const title = manifest?.title || "Update required";

  const serverBase = `http://localhost:${APP_PORT}`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self' 'unsafe-inline' http://localhost:${APP_PORT};
                 connect-src http://localhost:${APP_PORT};
                 img-src 'self' data:; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg:       #0b1020;
      --panel:    #11172c;
      --text:     #eef2ff;
      --muted:    #a7b0d6;
      --line:     rgba(255,255,255,.10);
      --accent:   #7c5cff;
      --green:    #5bdbb9;
      --danger:   #ff6b6b;
      --shadow:   0 18px 55px rgba(0,0,0,.45);
      --radius:   22px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; height: 100%;
      background:
        radial-gradient(circle at top left,    rgba(124,92,255,.22), transparent 30%),
        radial-gradient(circle at bottom right, rgba(91,219,185,.12), transparent 30%),
        var(--bg);
      color: var(--text);
      font-family: Inter, "Segoe UI", Roboto, system-ui, -apple-system, sans-serif;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      width: min(620px, 100%);
      background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .top {
      padding: 26px 26px 18px;
      background: linear-gradient(180deg, rgba(124,92,255,.18), transparent);
      border-bottom: 1px solid var(--line);
    }
    .badge {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 12px; border-radius: 999px;
      background: rgba(255,255,255,.08); border: 1px solid var(--line);
      color: var(--muted); font-size: 13px; margin-bottom: 16px;
    }
    h1 { font-size: 28px; line-height: 1.1; letter-spacing: -0.03em; }
    .sub { margin-top: 10px; color: var(--muted); font-size: 14px; line-height: 1.6; }
    .content { padding: 22px 26px 26px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px; margin-bottom: 18px;
    }
    .stat {
      background: rgba(255,255,255,.04); border: 1px solid var(--line);
      border-radius: 16px; padding: 14px 16px;
    }
    .label {
      color: var(--muted); font-size: 11px;
      text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px;
    }
    .value { font-size: 15px; font-weight: 700; }
    .value.new { color: var(--green); }
    .notes {
      margin-bottom: 20px; padding: 14px 16px;
      border-radius: 14px; background: rgba(255,255,255,.04);
      border: 1px solid var(--line);
      font-size: 13px; color: var(--muted);
      line-height: 1.6; white-space: pre-wrap;
      max-height: 100px; overflow-y: auto;
    }

    #progress-area { margin-bottom: 20px; }
    .progress-label {
      display: flex; justify-content: space-between;
      font-size: 12px; color: var(--muted); margin-bottom: 8px;
    }
    .track {
      height: 6px; background: rgba(255,255,255,.08);
      border-radius: 3px; overflow: hidden;
    }
    .bar {
      height: 100%; width: 0%;
      background: linear-gradient(90deg, var(--accent), var(--green));
      border-radius: 3px;
      transition: width .25s ease;
    }
    .bar.indeterminate {
      width: 40%;
      animation: slide 1.2s ease-in-out infinite alternate;
    }
    @keyframes slide {
      from { margin-left: 0%;   }
      to   { margin-left: 60%;  }
    }

    .btn {
      width: 100%; min-height: 46px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 14px; border: none;
      font-size: 15px; font-weight: 700;
      cursor: pointer; letter-spacing: .3px;
      transition: opacity .15s, transform .15s;
    }
    .btn:hover:not(:disabled) { transform: translateY(-1px); }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .btn-primary {
      background: linear-gradient(135deg, var(--accent), #9b7bff);
      color: #fff;
      box-shadow: 0 10px 24px rgba(124,92,255,.28);
    }
    .btn-done {
      background: linear-gradient(135deg, #2a9d5c, var(--green));
      color: #0a1a0a;
      box-shadow: 0 10px 24px rgba(91,219,185,.28);
    }
    .hint {
      margin-top: 14px; text-align: center;
      color: var(--muted); font-size: 12px; line-height: 1.6;
    }
    .hint a { color: var(--green); text-decoration: none; }
    .hint a:hover { text-decoration: underline; }
    .footer {
      padding: 0 26px 22px;
      font-size: 11px; color: rgba(167,176,214,.6);
    }
    @media (max-width: 480px) {
      .grid { grid-template-columns: 1fr; }
      h1 { font-size: 22px; }
    }
  </style>
</head>
<body>
<div class="card">
  <div class="top">
    <div class="badge">&#x1F6A8; Required update &bull; Coevas Panel</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="sub">
      This version cannot continue. Install the latest build to proceed.
    </p>
  </div>

  <div class="content">
    <div class="grid">
      <div class="stat">
        <div class="label">Installed</div>
        <div class="value">${escapeHtml(CURRENT_VERSION)}</div>
      </div>
      <div class="stat">
        <div class="label">Required</div>
        <div class="value new">${escapeHtml(latestVersion)}</div>
      </div>
    </div>

    ${notes ? `<div class="notes">${escapeHtml(notes)}</div>` : ""}

    <div id="progress-area" style="display:none;">
      <div class="progress-label">
        <span id="prog-label">Downloading…</span>
        <span id="prog-pct"></span>
      </div>
      <div class="track"><div class="bar" id="prog-bar"></div></div>
    </div>

    <button class="btn btn-primary" id="main-btn">Update Now</button>

    <div class="hint">
      Your cookies &amp; settings are preserved automatically.<br/>
      <a href="${escapeHtml(downloadUrl)}" id="manual-link">Download manually</a>
      if the in-app installer fails.
    </div>
  </div>

  <div class="footer">Openroot Systems &bull; Coevas Panel</div>
</div>

<script>
  const SERVER = ${JSON.stringify(serverBase)};
  const DL_URL = ${JSON.stringify(downloadUrl)};

  const btn = document.getElementById("main-btn");
  const progArea = document.getElementById("progress-area");
  const progBar = document.getElementById("prog-bar");
  const progLabel = document.getElementById("prog-label");
  const progPct = document.getElementById("prog-pct");
  const manualLink = document.getElementById("manual-link");

  manualLink.addEventListener("click", (e) => {
    e.preventDefault();
    window.open(DL_URL, "_blank");
  });

  function setState(state) {
    if (state === "idle") {
      btn.disabled = false;
      btn.textContent = "Update Now";
      btn.className = "btn btn-primary";
    } else if (state === "downloading") {
      btn.disabled = true;
      btn.textContent = "Downloading…";
      progArea.style.display = "";
    } else if (state === "applying") {
      btn.disabled = true;
      btn.textContent = "Installing…";
      progLabel.textContent = "Launching installer…";
      progPct.textContent = "";
      progBar.style.width = "100%";
    } else if (state === "done") {
      btn.disabled = true;
      btn.textContent = "Restarting…";
      btn.className = "btn btn-done";
      progLabel.textContent = "Update complete — app is restarting";
    } else if (state === "error") {
      btn.disabled = false;
      btn.textContent = "Retry";
    }
  }

  async function applyUpdate() {
    setState("applying");
    try {
      await fetch(SERVER + "/update/apply", { method: "POST" });
    } catch {
    }
    setState("done");
  }

  async function startDownload() {
    setState("downloading");

    const sse = new EventSource(SERVER + "/update/progress");

    sse.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(data);

        if (msg.error) {
          progLabel.textContent = "Error: " + msg.error;
          progPct.textContent = "";
          setState("error");
          sse.close();
          return;
        }

        if (msg.canceled) { sse.close(); return; }

        if (msg.done) {
          sse.close();
          applyUpdate();
          return;
        }

        if (typeof msg.percent === "number" && msg.percent >= 0) {
          progBar.classList.remove("indeterminate");
          progBar.style.width = msg.percent + "%";
          progLabel.textContent = "Downloading…";
          progPct.textContent = msg.percent + "%" +
            (msg.totalBytes
              ? " of " + (msg.totalBytes / 1024 / 1024).toFixed(1) + " MB"
              : "");
        } else if (msg.bytesReceived) {
          progBar.classList.add("indeterminate");
          progLabel.textContent = "Downloading…";
          progPct.textContent = (msg.bytesReceived / 1024 / 1024).toFixed(1) + " MB";
        }
      } catch {}
    };

    sse.onerror = () => sse.close();

    try {
      const res = await fetch(SERVER + "/update/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ downloadUrl: DL_URL }),
      });
      const body = await res.json();
      if (!body.ok) {
        progLabel.textContent = "Server error: " + (body.error || "unknown");
        setState("error");
        sse.close();
      }
    } catch (err) {
      progLabel.textContent = "Network error: " + err.message;
      setState("error");
      sse.close();
    }
  }

  btn.addEventListener("click", () => startDownload());
</script>
</body>
</html>`;

  updateWindow = new BrowserWindow({
    width: 680,
    height: 640,
    minWidth: 560,
    minHeight: 540,
    resizable: true,
    movable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    closable: true,
    icon: getAppIconPath(),
    title: title,
    backgroundColor: "#0b1020",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  updateWindow.setMenuBarVisibility(false);

  updateWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url) shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });

  updateWindow.on("close", (event) => {
    if (!appQuitting) {
      event.preventDefault();
      app.quit();
    }
  });
  updateWindow.on("closed", () => {
    updateWindow = null;
  });

  updateWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
  return updateWindow;
}

/* ─── Cookie bundle refresh ─────────────────────────────────── */
function getCookieStatePath() {
  return path.join(app.getPath("userData"), COOKIE_STATE_FILENAME);
}

function readCookieState() {
  try {
    const statePath = getCookieStatePath();
    if (!fs.existsSync(statePath)) return null;
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function writeCookieState(data) {
  try {
    fs.writeFileSync(getCookieStatePath(), JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.warn("[Cookies] Could not write cookie state:", err?.message || err);
  }
}

function bundledCookieCandidates(fileName) {
  return [
    path.join(__dirname, "../server/", fileName),
    path.join(process.resourcesPath || "", "server", fileName),
    path.join(process.resourcesPath || "", "app.asar.unpacked", "server", fileName),
  ];
}

function findBundledCookieSource(fileNames) {
  for (const name of fileNames) {
    for (const candidate of bundledCookieCandidates(name)) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
      }
    }
  }
  return null;
}

function migrateCookies() {
  const userDataDir = app.getPath("userData");

  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const cookieState = readCookieState();
  const lastBundleVersion = String(cookieState?.cookieBundleVersion || "0.0.0").trim() || "0.0.0";
  const currentBundleVersion = CURRENT_VERSION;
  const shouldOverwrite = compareVersions(currentBundleVersion, lastBundleVersion) > 0;

  const cookieFileMap = [
    { dest: "cookies_fbinsta.txt", sources: ["cookies_fbinsta.txt", "cookies_fbinsta"] },
    { dest: "cookies_terabox.txt", sources: ["cookies_terabox.txt", "cookies_terabox"] },
    { dest: "cookies_youtube.txt", sources: ["cookies_youtube.txt", "cookies_youtube"] },
  ];

  let wroteAny = false;

  for (const entry of cookieFileMap) {
    const dest = path.join(userDataDir, entry.dest);
    const src = findBundledCookieSource(entry.sources);

    if (!src) {
      console.log(`ℹ️ ${entry.dest} not found in bundle — skipping`);
      continue;
    }

    try {
      if (shouldOverwrite || !fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        wroteAny = true;
        console.log(
          `${shouldOverwrite ? "🔥 Updated" : "✅ Seeded"} cookie file: ${path.basename(src)} → ${dest}`
        );
      } else {
        console.log(`✔️ Keeping existing cookie file: ${entry.dest}`);
      }
    } catch (e) {
      console.warn(`⚠️ Cookie copy failed for ${entry.dest}:`, e.message);
    }
  }

  if (wroteAny) {
    writeCookieState({
      cookieBundleVersion: currentBundleVersion,
      updatedAt: new Date().toISOString(),
    });
  }
}

/* ─── Poll until Express is accepting connections ──────────── */
function waitForServer(port, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = 250;

    const check = () => {
      const req = http.get(`http://localhost:${port}/`, (res) => {
        res.resume();
        resolve();
      });

      req.on("error", () => {
        if (Date.now() - start > timeout) {
          reject(new Error(`Server on :${port} never became ready`));
        } else {
          setTimeout(check, interval);
        }
      });

      req.setTimeout(500, () => {
        req.destroy();
        if (Date.now() - start > timeout) {
          reject(new Error("Server ready-check timed out"));
        } else {
          setTimeout(check, interval);
        }
      });
    };

    check();
  });
}

/* ─── Browser window ───────────────────────────────────────── */
function createWindow() {
  const preloadPath = path.join(__dirname, "preload.js");

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: getAppIconPath(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadURL(`http://localhost:${APP_PORT}`);
  console.log(`✅ UI loaded → http://localhost:${APP_PORT}  [${IS_DEV ? "DEV" : "PROD"}]`);
}

/* ─── IPC handlers ─────────────────────────────────────────── */
ipcMain.handle("open-folder-dialog", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});

/* ─── Resolve server.js path ───────────────────────────────── */
function getServerPath() {
  const candidates = [
    path.join(__dirname, "../server/server.js"),
    path.join(process.resourcesPath, "server/server.js"),
    path.join(process.resourcesPath, "app.asar.unpacked/server/server.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("server.js not found in any candidate path");
}

/* ─── Start embedded Express ───────────────────────────────── */
async function startEmbeddedExpressServer() {
  const serverPath = getServerPath();
  console.log(`⚙️  Loading server from: ${serverPath}`);

  const moduleUrl = pathToFileURL(serverPath).href;
  const mod = await import(moduleUrl);

  embeddedServer = mod.startServer(APP_PORT);

  if (typeof mod.stopServer === "function") {
    stopEmbeddedServer = mod.stopServer;
  }
}

/* ─── Graceful shutdown ────────────────────────────────────── */
function shutdownServer() {
  try {
    if (stopEmbeddedServer) stopEmbeddedServer();
    else if (embeddedServer) embeddedServer.close();
  } catch {}
}

/* ─── Server → main process update signal ───────────────────── */
process.on("coevas-apply-update", () => {
  console.log("[Update] Received apply signal — quitting Electron.");
  appQuitting = true;
  shutdownServer();
  app.quit();
});

/* ─── Boot sequence ────────────────────────────────────────── */
app.whenReady().then(async () => {
  process.env.COEVAS_USER_DATA = app.getPath("userData");
  process.env.APP_VERSION = CURRENT_VERSION;
  process.env.GITHUB_OWNER = GITHUB_OWNER;
  process.env.GITHUB_REPO = GITHUB_REPO;

  console.log(`📁 userData: ${process.env.COEVAS_USER_DATA}`);
  console.log(`🏷️  Version : ${CURRENT_VERSION}`);
  console.log(`🐙 Repo    : ${GITHUB_OWNER}/${GITHUB_REPO}`);
  console.log(`🔄 Update manifest: ${UPDATE_MANIFEST_URL || "NOT SET"}`);
  migrateCookies();

  try {
    await startEmbeddedExpressServer();
    console.log(`⚙️  Express started, waiting for :${APP_PORT}...`);

    await waitForServer(APP_PORT);
    console.log(`✅ Server ready on :${APP_PORT}`);
  } catch (err) {
    console.error("❌ Server start failed:", err.message);
  }

  try {
    const updateGate = await checkForcedUpdateGate();

    if (updateGate.required) {
      console.warn(
        `[Update] Forced update required. Current=${CURRENT_VERSION}, Latest=${updateGate.manifest?.latestVersion}`
      );
      createForceUpdateWindow(updateGate.manifest);
      return;
    }

    console.log(`[Update] Up to date (${CURRENT_VERSION}) ✓`);
  } catch (err) {
    console.warn("[Update] Gate check failed, continuing startup:", err?.message || err);
  }

  createWindow();
});

app.on("before-quit", () => {
  appQuitting = true;
  shutdownServer();
});

app.on("window-all-closed", () => {
  shutdownServer();
  if (process.platform !== "darwin") app.quit();
});