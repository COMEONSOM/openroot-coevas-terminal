<div align="center">

  <h1>Coevas Terminal</h1>
  <p><strong>Unified Media Downloader for Windows</strong></p>
  <p>Built by <a href="https://openroot.in/">Openroot Systems</a></p>

  <p>
    <img src="https://img.shields.io/badge/Electron-191970?style=for-the-badge&logo=Electron&logoColor=white" alt="Electron">
    <img src="https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js">
    <img src="https://img.shields.io/badge/Express.js-404D59?style=for-the-badge" alt="Express">
    <img src="https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white" alt="Windows">
  </p>

  <p>
    <img src="https://img.shields.io/badge/yt--dlp-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="yt-dlp">
    <img src="https://img.shields.io/badge/ffmpeg-007808?style=for-the-badge&logo=ffmpeg&logoColor=white" alt="ffmpeg">
    <img src="https://img.shields.io/badge/gallery--dl-E4405F?style=for-the-badge&logo=instagram&logoColor=white" alt="gallery-dl">
  </p>

</div>

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [System Requirements](#system-requirements)
- [Project Structure](#project-structure)
- [Development Setup](#development-setup)
- [Build & Release Workflow](#build--release-workflow)
- [Repository Architecture](#repository-architecture)
- [Update System](#update-system)
- [Scripts Reference](#scripts-reference)
- [Distribution](#distribution)
- [Uninstallation](#uninstallation)
- [Troubleshooting](#troubleshooting)

---

## Overview

**Coevas Terminal** is a standalone Windows desktop application built on Electron. It provides a unified interface for advanced media downloading operations across multiple platforms including YouTube, Instagram, Facebook, Threads, and Terabox.

> **Product Name:** Coevas Terminal
> **Organization:** Openroot Systems
> **Type:** Electron-based desktop application

---

## Architecture

```
+-------------------------------------+
|         Coevas Terminal             |  <- User-facing Electron App
|  +-------------------------------+  |
|  |        Coevas Panel           |  |  <- Internal Processing Engine
|  |  +---------+  +---------+    |  |
|  |  | yt-dlp  |  | ffmpeg  |    |  |
|  |  +---------+  +---------+    |  |
|  |  +---------+  +---------+    |  |
|  |  |gallery-dl|  |   SSE   |    |  |
|  |  +---------+  +---------+    |  |
|  +-------------------------------+  |
+-------------------------------------+
```

### Core Components

| Component | Role | Description |
|-----------|------|-------------|
| **Coevas Terminal** | User Interface | The Electron desktop app users interact with |
| **Coevas Panel** | Processing Engine | Internal architecture handling download pipelines, extraction logic, and fallback strategies |

**Responsibilities of Coevas Panel:**

- Managing multiple download pipelines
- Handling platform-specific extraction logic
- Coordinating media processing and merging
- Managing fallback strategies across sources
- Ensuring stability across content types

---

## Technology Stack

| Technology | Purpose |
|------------|---------|
| Electron | Desktop app framework |
| Node.js | Runtime environment |
| Express | Embedded backend server |
| yt-dlp | Primary media downloader |
| ffmpeg | Media processing |
| gallery-dl | Instagram/Threads downloader |
| SSE | Live logs and progress streaming |

---

## System Requirements

Install the following system-level dependencies before running or building:

| Dependency | Download | Verification Command |
|-----------|----------|----------------------|
| Node.js (LTS) | [nodejs.org](https://nodejs.org) | `node --version` |
| yt-dlp | [GitHub Releases](https://github.com/yt-dlp/yt-dlp/releases) | `yt-dlp --version` |
| ffmpeg | [ffmpeg.org](https://ffmpeg.org/download.html) | `ffmpeg -version` |
| gallery-dl | `pip install gallery-dl` | `gallery-dl --version` |

---

## Project Structure

```text
openroot-coevas-terminal/
|
+-- electron/
|   +-- main.js              # Electron main process
|   +-- preload.js           # Preload script & context bridge
|
+-- server/
|   +-- server.js            # Express server entry
|   +-- youtube.js           # YouTube download handler
|   +-- instagram.js         # Instagram download handler
|   +-- facebook.js          # Facebook download handler
|   +-- threads.js           # Threads download handler
|   +-- utils/               # Server utilities
|
+-- public/
|   +-- index.html           # App UI markup
|   +-- style.css            # App styles
|   +-- app.js               # Frontend logic
|   +-- assets/              # Images & resources
|
+-- scripts/
|   +-- bump-version.cjs     # Version increment logic
|   +-- update-manifest.cjs  # update.json generator
|
+-- package.json             # Project config
+-- dist/                    # Build output
```

---

## Development Setup

### Quick Start

```bash
# 1. Navigate to project root
cd <project-root>

# 2. Install dependencies
cd server && npm install
cd ..
npm install

# 3. Start development mode
npm start
```

### Development Server

| Mode | Port | Behavior |
|------|------|----------|
| Development | `3000` | Live source files, hot reload |
| Production | `39281` | Bundled build, optimized |

> **Development URL:** `http://localhost:3000`

### Kill Port Conflicts

```bash
taskkill /F /IM node.exe
```

---

## Build & Release Workflow

### What `npm run build` Does

```bash
npm run build
```

| Step | Script | Output |
|------|--------|--------|
| 1 | `bump-version.cjs` | `package.json` version incremented, `buildVersion` synced |
| 2 | `update-manifest.cjs` | `update.json` regenerated with new metadata |
| 3 | `electron-builder` | Versioned `.exe` installer created in `dist/` |

### Release Checklist

- [ ] Complete code changes and testing
- [ ] Run `npm run build` to bump version and generate installer
- [ ] Verify `dist/` contains the new `.exe`
- [ ] Upload `.exe` and `update.json` to `openroot-web` releases
- [ ] Commit source changes: `git commit -m "vX.X.X"`
- [ ] Push to `openroot-coevas-terminal`

---

## Repository Architecture

Coevas Terminal uses a **two-repository workflow** to separate development from public delivery.

### Development Repository

| Property | Value |
|----------|-------|
| **Name** | `openroot-coevas-terminal` |
| **Purpose** | Source code, build scripts, internal workflow |
| **Actions** | `npm run build` -> `git commit` -> `git push` |
| **Contents** | Electron source, server logic, media extraction systems |

### Public Release Repository

| Property | Value |
|----------|-------|
| **Name** | `openroot-web` |
| **Purpose** | GitHub Releases, public downloads, update manifest |
| **Critical Files** | `update.json`, `.exe` installers |

### Update Manifest URL

```
https://raw.githubusercontent.com/COMEONSOM/openroot-web/main/update.json
```

> **Critical:** The app fetches this URL on startup. If the manifest or installer is missing, users will not receive updates.

---

## Update System

### `update.json` Schema

```json
{
  "latestVersion": "1.3.0",
  "minimumRequiredVersion": "1.2.0",
  "forceUpdate": false,
  "downloadUrl": "https://github.com/COMEONSOM/openroot-web/releases/download/v1.3.0/CoevasTerminal-1.3.0.exe",
  "title": "Version 1.3.0 Released",
  "releaseNotes": "Bug fixes and performance improvements"
}
```

### User Update Flow

```
+-------------+     +--------------+     +-------------+
| User Opens  | --> | App Fetches  | --> | Compare     |
|    App      |     |  update.json |     |  Versions   |
+-------------+     +--------------+     +------+------+
                                                |
                    +-------------+     +-------v-----+
                    | Install New | <-- | Newer Ver?  |
                    |   Version   | Yes +-------------+
                    +-------------+          | No
                                             v
                                       +-------------+
                                       | Continue App|
                                       +-------------+
```

### Update Rules

| Condition | Behavior |
|-----------|----------|
| `latestVersion` > installed | Show update prompt |
| `forceUpdate` = `true` | Block app until updated |
| Offline / manifest unreachable | Continue silently |

---

## Scripts Reference

| Script | File | Purpose |
|--------|------|---------|
| `bump-version.cjs` | `scripts/bump-version.cjs` | Auto-increments version, syncs `buildVersion`, updates `package-lock.json` |
| `update-manifest.cjs` | `scripts/update-manifest.cjs` | Regenerates `update.json` with new version, download URL, and metadata |

### Website Dev Server

```bash
# Basic server
npx http-server .

# Disable cache (recommended for development)
npx http-server -c-1 .
```

### Obfuscation

```bash
npm run obfuscate:site
```

> **Note:** Only commit `script.obf.js`. Never commit raw `script.js`.

---

## Distribution

### Step-by-Step Distribution

| Step | Action | Target |
|------|--------|--------|
| 1 | `npm run build` | Local `dist/` folder |
| 2 | Confirm version in filename | e.g. `CoevasTerminal-1.3.0.exe` |
| 3 | Upload `.exe` | `openroot-web` GitHub Releases |
| 4 | Upload `update.json` | `openroot-web` repository root |
| 5 | Update website links | If applicable |

---

## Uninstallation

1. Uninstall via **Windows Settings > Apps**
2. Delete residual files manually:

```text
%LocalAppData%\Programs\
%AppData%\
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Port 3000/39281 in use | `taskkill /F /IM node.exe` |
| Binaries not found | Verify `yt-dlp`, `ffmpeg`, `gallery-dl` are added to PATH |
| Build version mismatch | Run `npm run build` to regenerate manifests |
| Users not getting updates | Check `update.json` is uploaded to `openroot-web` root |
| Fresh clone won't start | Manually download `yt-dlp`, `ffmpeg`, `ffprobe` first |

---

## Important Notes

- **Coevas Terminal** is the product brand (user-facing name).
- **Coevas Panel** is the internal engine (architecture reference only).
- Always regenerate `update.json` before publishing a release.
- Running `npm run build` does **not** push updates to users — only publishing the release to `openroot-web` does.

---

<div align="center">

**Maintained by [Openroot Systems](https://openroot.in/)**

<p>
  <img src="https://img.shields.io/badge/Made%20with-Electron-191970?style=flat-square" alt="Electron">
  <img src="https://img.shields.io/badge/License-Proprietary-red?style=flat-square" alt="License">
</p>

</div>
