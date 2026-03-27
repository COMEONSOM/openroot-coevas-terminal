# ================================
# COEVAS PERSONAL DEV HANDBOOK
# ================================
# Future me — read this before touching anything.


# ------------------------------------------------
# PROJECT: Coevas-Panel-Openroot (Electron App)
# ------------------------------------------------


## 🛠️ Tech Stack

Electron        – Desktop app shell
Node.js         – Runtime
Express         – Embedded backend server (runs inside the app)
yt-dlp          – Video downloader engine
ffmpeg          – Media merging / processing
gallery-dl      – Instagram/Threads carousel downloader
JavaScript ESM  – Modern JS modules (import/export everywhere)
SSE             – Server-Sent Events for live progress + logs


## 📁 Project Structure

coevas-panel-openroot/       ← ROOT (run everything from here)
├── electron/
│   ├── main.js              ← Electron entry point
│   └── preload.js
├── server/
│   ├── server.js            ← Express backend
│   ├── youtube.js
│   ├── instagram.js
│   ├── facebook.js
│   ├── threads.js
│   └── utils/
├── public/
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── assets/
├── package.json             ← ROOT package.json (controls everything)
└── dist/                    ← Built .exe output goes here


## 📦 System Requirements

Install these globally on your machine (not npm — system-level):

  yt-dlp      → https://github.com/yt-dlp/yt-dlp/releases
  ffmpeg      → https://ffmpeg.org/download.html
  gallery-dl  → pip install gallery-dl
  Node.js     → https://nodejs.org (LTS version)

Verify everything works:

  node --version
  yt-dlp --version
  ffmpeg -version
  gallery-dl --version


## ▶️ Development (Running Locally)

ALWAYS run from the ROOT folder, not from electron/ or server/:

  cd C:\Users\aryan\.antigravity\coevas-panel-openroot
  npm start

This opens the Electron desktop app in dev mode.
It reads your source files live — every save reflects instantly.
Runs on: http://localhost:3000 internally.

To test in browser only (no Electron):

  cd server
  npm install      ← only needed first time
  node server.js
  → Open http://localhost:3000 in browser


## ⚠️ IMPORTANT: Dev vs Production Port Behaviour

The app uses DIFFERENT ports in dev vs prod to avoid conflicts:

  npm start (dev)   → port 3000   reads your SOURCE files live
  Built .exe (prod) → port 39281  reads FROZEN bundled resources

WHY THIS MATTERS:
If you run npm start AND open the built .exe at the same time,
previously the .exe would steal the dev server on port 3000 and
show your latest source changes instead of the frozen build.
This is now fixed — they use different ports and never conflict.

If you ever see the .exe showing wrong/live content:
  taskkill /F /IM node.exe
Then reopen the .exe. (Kill the dev node process that was squatting port 39281.)


## 🏗️ Building the Installer (.exe)

When everything works in dev, build the installer:

  cd C:\Users\aryan\.antigravity\coevas-panel-openroot
  npm run build

Output:
  dist/CoevasTerminalSetup.exe   ← installer to distribute
  dist/win-unpacked/             ← unpackaged version (test without installing)

⚠️ If the build fails with permission errors:
  1. Close terminal
  2. Open PowerShell as Administrator (right-click → Run as Administrator)
  3. cd C:\Users\aryan\.antigravity\coevas-panel-openroot
  4. npm run build


## 🔒 Built .exe is Completely Frozen

After building, the .exe bundles everything inside:
  resources/server/    ← frozen copy of server/ at build time
  resources/public/    ← frozen copy of public/ at build time

Changing your source files AFTER building does NOTHING to the installed app.
You must rebuild (npm run build) to update the installed version.

This means:
  Source change → reflected in:  npm start  ✅
  Source change → NOT reflected: installed .exe  ✅ (this is correct behaviour)


## 🗂️ Version Control (Do This Before Every Build)

  git add .
  git commit -m "v1.x.x — describe what changed"
  git tag v1.x.x
  npm run build

If you break something later:
  git checkout v1.x.x   ← jump back to working version
  npm run build         ← rebuild clean exe from that snapshot

Keep old .exe files renamed with version numbers:
  CoevasTerminal-v1.0.0-Setup.exe
  CoevasTerminal-v1.1.0-Setup.exe


## 🔄 Uninstall Old Version Before Reinstalling

1. Windows key → Settings → Apps → Installed apps
2. Find: Coevas Terminal → Uninstall

Clean leftover files:
  Windows + R → %LocalAppData%\Programs → delete Coevas Terminal folder
  Windows + R → %AppData%              → delete any Coevas folder


## 🚀 Distribution Workflow

  1. npm run build
  2. Rename: dist/CoevasTerminalSetup.exe → CoevasTerminal-vX.X.X-Setup.exe
  3. Upload to Google Drive
  4. Update download link in website script.js:

     {
       version: "1.x.x",
       date: "2026-XX-XX",
       driveViewLink: "https://drive.google.com/file/d/XXXX/view?usp=sharing"
     }

## 🔧 After Cloning (Fresh Setup)

These are NOT in the repo (too large). Download manually:

server/yt-dlp.exe    → https://github.com/yt-dlp/yt-dlp/releases/latest
server/ffmpeg.exe    → https://ffmpeg.org/download.html
server/ffprobe.exe   → (same ffmpeg download, extract both)

Then from root:
  cd server && npm install
  cd .. && npm start


# ------------------------------------------------
# PROJECT: Coevas-Systems-Openroot (Website)
# ------------------------------------------------


## ▶️ Run Locally

  npx http-server .        ← serves current folder at http://localhost:8080

  npx http-server -c-1 .  ← same but with cache DISABLED (use this while developing)
                             -c-1 means: no caching, always fresh files

Access on same network:
  http://127.0.0.1:8080     ← your machine
  http://10.x.x.x:8080      ← other devices on same WiFi

If you see different styling on different IPs → just a cache issue.
Fix: Ctrl + Shift + R (hard refresh) or use -c-1 flag above.


## 🔐 Obfuscation Workflow

Edit script.js openly. Never upload raw script.js to GitHub.
Always obfuscate first, then deploy script.obf.js.

One-time setup (already done):
  npm install

Obfuscate command:
  npm run obfuscate:site

This reads script.js and outputs script.obf.js automatically.

Full workflow every release:
  1. Edit script.js
  2. npm run obfuscate:site
  3. Commit + push (script.obf.js goes to GitHub, not script.js)
  4. GitHub Pages serves script.obf.js ✅
