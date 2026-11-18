# Desktop Build & Windows Installer Packaging Guide

## 1. Prerequisites (Developer Build Machine)
- **Operating System**: Windows 11 or Windows 10 x64 (recommended for producing `.exe` installers without Wine).
- **Node.js**: Node.js `22.x` LTS (`node -v` >= `22.14.0`, required for built-in `node:sqlite`).
- **Build Output**: Once packaged with `electron-builder`, **end users do NOT need Node.js installed**.

## 2. Development & Build Commands

```bash
# Install dependencies
npm install

# Run Web + Electron TypeScript checks
npm run lint

# Run all automated tests (Core + Agent + Desktop + SqlServerAdapter)
npm test && npm run desktop:test

# Build Vite client + Electron main/preload/bundled server.mjs (for desktop:dev)
npm run desktop:build

# Launch Electron Desktop Edition in development mode (Windows workstation with GUI)
npm run desktop:dev

# Package Windows x64 NSIS Installer & Portable .exe into release/
npm run desktop:dist
```

## 3. Packaging Configuration (`electron-builder.yml`)
- `appId`: `com.visualdatabasestudio.desktop`
- `productName`: `Visual Database Studio`
- `files`: includes `dist/**/*`, `dist-electron/**/*`, `electron/loading.html`, `electron/assets/**/*`, `package.json` (`asar: true`).
- `win` targets:
  - `nsis` (`x64`): `VisualDatabaseStudio-Setup-${version}.exe` (`perMachine: false`, Start Menu + Desktop shortcut).
  - `portable` (`x64`): `VisualDatabaseStudio-Portable-${version}.exe`.

## 4. Code Signing & Auto-Updater Notes
- Unconfigured/unsigned builds keep automatic updates **disabled** (`DesktopUpdater.isEnabled() === false`).
- For commercial distribution, sign installers via Authenticode (`CSC_LINK` / Azure Trusted Signing) and configure `VDS_UPDATE_FEED_URL` (HTTPS) + `VDS_UPDATE_SIGNED=true` only when publishing signed `latest.yml` releases.
