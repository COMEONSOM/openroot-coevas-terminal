Coevas Terminal — Developer Handbook
This document serves as the official development and deployment guide for the Coevas Terminal desktop application.
---
Project Overview
Product Name: Coevas Terminal  
Organization: Openroot Systems  
Type: Electron-based desktop application
Coevas Terminal is a standalone Windows desktop application built using Electron. It provides a unified interface for advanced media downloading operations across multiple platforms.
---
Core Architecture
Coevas Terminal is powered by an internal processing system referred to as the Coevas Panel.
What is Coevas Panel?
Coevas Panel is not the application itself. It is the internal processing architecture and strategy layer responsible for handling complex media operations.  
It coordinates multiple tools and workflows to ensure reliable and efficient downloading.
Responsibilities of Coevas Panel
Managing multiple download pipelines
Handling platform-specific extraction logic
Coordinating media processing and merging
Managing fallback strategies across different sources
Ensuring stability across different content types
In simple terms:
Coevas Terminal → User-facing desktop application
Coevas Panel → Internal processing engine powering the application
---
Technology Stack
Electron (Desktop application framework)
Node.js (Runtime environment)
Express (Embedded backend server)
yt-dlp (Primary media downloading engine)
ffmpeg (Media processing and merging)
gallery-dl (Instagram and Threads downloader)
JavaScript (ES Modules)
Server-Sent Events (SSE) for live logs and progress
---
Project Structure
```text
openroot-coevas-terminal/
│
├── electron/
│   ├── main.js
│   └── preload.js
│
├── server/
│   ├── server.js
│   ├── youtube.js
│   ├── instagram.js
│   ├── facebook.js
│   ├── threads.js
│   └── utils/
│
├── public/
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── assets/
│
├── scripts/
│   ├── bump-version.cjs
│   └── update-manifest.cjs
│
├── package.json
└── dist/
```
---
System Requirements
Install the following dependencies at the system level:
Node.js (LTS): https://nodejs.org
yt-dlp: https://github.com/yt-dlp/yt-dlp/releases
ffmpeg: https://ffmpeg.org/download.html
gallery-dl:
```bash
  pip install gallery-dl
  ```
Verification
```bash
node --version
yt-dlp --version
ffmpeg -version
gallery-dl --version
```
---
Development Setup
Always run commands from the project root directory.
```bash
cd <project-root>
npm start
```
This launches Coevas Terminal in development mode.
Development server runs on: `http://localhost:3000`
Source files are loaded dynamically
---
Development vs Production Behavior
Mode	Port	Behavior
Development	3000	Uses live source files
Production	39281	Uses bundled build
If conflicts occur:
```bash
taskkill /F /IM node.exe
```
---
Build and Version Workflow
This project uses an automated versioning workflow so that build metadata stays aligned with the installer and update manifest.
What happens when you run a build
```bash
npm run build
```
The build process follows this order:
Version bump runs first
`package.json` version is increased automatically
`build.buildVersion` is synced to the same value
`package-lock.json` is updated too
Update manifest is regenerated
`update.json` is rewritten with the new version
`latestVersion` is updated
`minimumRequiredVersion` is updated
`downloadUrl` is rebuilt for the new release asset
Installer is built
`electron-builder` generates the new `.exe`
The output file name includes the updated version
Practical release sequence
The correct release flow is:
Make your code changes
Run:
```bash
   npm run build
   ```
Upload the newly generated `.exe` and `update.json` to GitHub Releases or the online location used by the app
Commit and push the source code changes
Users on older versions will receive the update prompt when the app checks the online manifest
Important note
The automatic build step prepares the new installer and metadata, but users only receive the update after the new release files are published online.
---
Scripts Used for Version Sync
The project uses helper scripts inside the `scripts/` folder:
`scripts/bump-version.cjs`
Increments the app version
Keeps `buildVersion` in sync
Updates `package-lock.json`
`scripts/update-manifest.cjs`
Regenerates `update.json`
Points the manifest to the newly built release asset
---
Distribution Workflow
Build the installer
Confirm the version and file name
Upload the new `.exe` and `update.json` to GitHub Releases
Update website links if required
---
Version Control Workflow
Recommended workflow:
```bash
npm run build
git add .
git commit -m "vX.X.X - description"
git push
```
To revert:
```bash
git checkout vX.X.X
npm run build
```
---
Update System Workflow
Coevas Terminal uses an online update manifest to notify users about new releases.
Manifest behavior
The manifest file contains:
latest available version
minimum required version
forced update flag
download URL
update title
release notes
Expected behavior
When a user opens the app:
The app checks the hosted `update.json`
It compares the installed version with `latestVersion`
If a newer version exists, the app shows the update prompt
If `forceUpdate` is enabled, the user must update before continuing
The user downloads the latest installer from the configured URL
Example manifest flow
If the current app version is `1.2.0` and a new build produces `1.3.0`, then:
`update.json` should point to `1.3.0`
the GitHub Release asset should also be `v1.3.0`
users on older builds will be redirected to the new installer
---
Uninstallation
Remove via Windows Settings → Apps.
Then delete residual files:
```text
%LocalAppData%\Programs\
%AppData%\
```
---
Fresh Setup After Cloning
Download required binaries manually:
yt-dlp
ffmpeg
ffprobe
Then:
```bash
cd server && npm install
cd ..
npm start
```
---
Website Development
```bash
npx http-server .
```
Disable cache:
```bash
npx http-server -c-1 .
```
---
Obfuscation Workflow
```bash
npm run obfuscate:site
```
Only commit `script.obf.js`, never raw `script.js`.
---
Notes
Coevas Terminal is the product
Coevas Panel is the internal processing system
Keep user-facing branding and internal architecture clearly separated
Always regenerate the update manifest before publishing a new release
---
Maintained by Openroot Systems