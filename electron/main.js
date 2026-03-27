import { app, BrowserWindow, ipcMain, dialog } from "electron";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// dev  → port 3000  (npm start, reads source files)
// prod → port 39281 (built .exe, reads frozen resources)
const IS_DEV   = !app.isPackaged;
const APP_PORT = IS_DEV ? 3000 : 39281;

let embeddedServer     = null;
let stopEmbeddedServer = null;

/* ─── App icon path ────────────────────────────────────────── */
function getAppIconPath() {
  const candidates = [
    path.join(__dirname, "../public/assets/company-icon.png"),
    path.join(process.resourcesPath, "public/assets/company-icon.png")
  ];
  return candidates.find(p => fs.existsSync(p));
}

/* ─── Migrate cookies from asar → writable userData (one-time) */
function migrateCookies() {
  const userDataDir = app.getPath("userData");

  // Ensure userData dir exists
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  // Files to migrate: [source inside bundle, dest in userData]
  const cookieFiles = [
    "cookies_fbinsta",
    "cookies_youtube.txt"
  ];

  for (const file of cookieFiles) {
    const dest = path.join(userDataDir, file);
    if (fs.existsSync(dest)) continue; // already migrated

    // Look in source folder (dev) or bundle root (prod)
    const candidates = [
      path.join(__dirname, "../", file),
      path.join(__dirname, "../server/", file),
      path.join(process.resourcesPath || "", file),
      path.join(process.resourcesPath || "", "server", file)
    ];

    const src = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });

    if (src) {
      try {
        fs.copyFileSync(src, dest);
        console.log(`✅ Migrated: ${file} → ${dest}`);
      } catch (e) {
        console.warn(`⚠️ Could not migrate ${file}:`, e.message);
      }
    } else {
      console.log(`ℹ️ ${file} not found in bundle — will be created fresh on first use`);
    }
  }
}

/* ─── Poll until Express is accepting connections ──────────── */
function waitForServer(port, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start    = Date.now();
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
    width:  1200,
    height: 800,
    icon:   getAppIconPath(),
    webPreferences: {
      preload:          preloadPath,
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false
    }
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
    path.join(process.resourcesPath, "app.asar.unpacked/server/server.js")
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
  const mod       = await import(moduleUrl);

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

/* ─── Boot sequence ────────────────────────────────────────── */
app.whenReady().then(async () => {

  // ✅ Set writable userData path for cookies — must be before server starts
  process.env.COEVAS_USER_DATA = app.getPath("userData");
  console.log(`📁 userData: ${process.env.COEVAS_USER_DATA}`);

  // ✅ Migrate existing cookies to writable location (one-time)
  migrateCookies();

  try {
    await startEmbeddedExpressServer();
    console.log(`⚙️  Express started, waiting for :${APP_PORT}...`);

    await waitForServer(APP_PORT);
    console.log(`✅ Server ready on :${APP_PORT}`);
  } catch (err) {
    console.error("❌ Server start failed:", err.message);
    // Open window anyway — will show error in UI
  }

  createWindow();
});

app.on("before-quit",       shutdownServer);
app.on("window-all-closed", () => {
  shutdownServer();
  if (process.platform !== "darwin") app.quit();
});
