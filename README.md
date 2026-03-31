# Coevas Terminal — Developer Handbook

This document serves as the official development and deployment guide for the Coevas Terminal desktop application.

---

## Project Overview

**Product Name:** Coevas Terminal  
**Organization:** Openroot Systems  
**Type:** Electron-based desktop application  

Coevas Terminal is a standalone Windows desktop application built using Electron. It provides a unified interface for advanced media downloading operations across multiple platforms.

---

## Core Architecture

Coevas Terminal is powered by an internal processing system referred to as the **Coevas Panel**.

### What is Coevas Panel?

Coevas Panel is not the application itself. It is the **internal processing architecture and strategy layer** responsible for handling complex media operations.
It coordinates multiple tools and workflows to ensure reliable and efficient downloading.

### Responsibilities of Coevas Panel

- Managing multiple download pipelines  
- Handling platform-specific extraction logic  
- Coordinating media processing and merging  
- Managing fallback strategies across different sources  
- Ensuring stability across different content types  

In simple terms:

- **Coevas Terminal** → User-facing desktop application  
- **Coevas Panel** → Internal processing engine powering the application  

---

## Technology Stack

- Electron (Desktop application framework)  
- Node.js (Runtime environment)  
- Express (Embedded backend server)  
- yt-dlp (Primary media downloading engine)  
- ffmpeg (Media processing and merging)  
- gallery-dl (Instagram and Threads downloader)  
- JavaScript (ES Modules)  
- Server-Sent Events (SSE) for live logs and progress  

---

## Project Structure

```
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
├── package.json
└── dist/
```

---

## System Requirements

Install the following dependencies at the system level:

- Node.js (LTS): https://nodejs.org  
- yt-dlp: https://github.com/yt-dlp/yt-dlp/releases  
- ffmpeg: https://ffmpeg.org/download.html  
- gallery-dl:
  ```bash
  pip install gallery-dl
  ```

### Verification

```bash
node --version
yt-dlp --version
ffmpeg -version
gallery-dl --version
```

---

## Development Setup

Always run commands from the project root directory.

```bash
cd <project-root>
npm start
```

This launches Coevas Terminal in development mode.

- Development server runs on: `http://localhost:3000`  
- Source files are loaded dynamically  

---

## Development vs Production Behavior

| Mode        | Port   | Behavior |
|------------|--------|----------|
| Development | 3000   | Uses live source files |
| Production  | 39281  | Uses bundled build |

If conflicts occur:

```bash
taskkill /F /IM node.exe
```

---

## Build Process

```bash
npm run build
```

### Output

- `dist/CoevasTerminalSetup.exe`  
- `dist/win-unpacked/`  

### Important

The built application is fully bundled. Any source changes require rebuilding.

---

## Version Control Workflow

```bash
git add .
git commit -m "vX.X.X - description"
git tag vX.X.X
npm run build
```

To revert:

```bash
git checkout vX.X.X
npm run build
```

---

## Uninstallation

Remove via Windows Settings → Apps.

Then delete residual files:

```
%LocalAppData%\Programs\
%AppData%\
```

---

## Distribution Workflow

1. Build the installer  
2. Rename with version  
3. Upload to GitHub Releases  
4. Update website links  

---

## Fresh Setup After Cloning

Download required binaries manually:

- yt-dlp  
- ffmpeg  
- ffprobe  

Then:

```bash
cd server && npm install
cd ..
npm start
```

---

## Website Development

```bash
npx http-server .
```

Disable cache:

```bash
npx http-server -c-1 .
```

---

## Obfuscation Workflow

```bash
npm run obfuscate:site
```

Only commit `script.obf.js`, never raw `script.js`.

---

## Notes

- Coevas Terminal is the product  
- Coevas Panel is the internal processing system  
- Maintain clear separation between user-facing branding and internal architecture  

---

**Maintained by Openroot Systems**
