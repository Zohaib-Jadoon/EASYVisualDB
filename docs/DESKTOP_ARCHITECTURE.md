# Desktop Architecture — Visual Database Studio (Electron x64)

## 1. Runtime Process Model
Visual Database Studio Desktop Edition runs a strict multi-process Electron `45.3.4` architecture on Windows 11, Windows 10 x64, and Windows Server 2019–2025:

1. **Main Process (`electron/main.ts` -> `dist-electron/main.cjs`)**:
   - Acquires `app.requestSingleInstanceLock()` and sets Windows AppUserModelId (`com.visualdatabasestudio.desktop`).
   - Provisions `DesktopBackendManager`, `DesktopUpdater`, `DesktopMenuManager`, IPC handlers (`electron/ipc/handlers.ts`), and the primary `BrowserWindow` (`electron/window-manager.ts`).
   - Displays `electron/loading.html` while the bundled backend starts, then navigates cleanly to `http://127.0.0.1:<port>`.
   - Coordinates graceful `before-quit` teardown so all `mssql` pools and `node:sqlite` connections close cleanly before process exit.
2. **Preload Script (`electron/preload.ts` -> `dist-electron/preload.cjs`)**:
   - Executes inside sandboxed renderer context and exposes ONLY the typed `window.vdsDesktop` API via `contextBridge.exposeInMainWorld`.
3. **Renderer Process (React 19 SPA from `dist/index.html`)**:
   - Shares 100% of the UI codebase with Web Edition (`src/App.tsx`, `src/components/*`).
   - Detects `window.vdsDesktop` via `src/lib/desktopBridge.ts` to activate native dialogs, menu state sync, DPAPI wipe controls, logs viewer, and persisted desktop preferences.
4. **Bundled Backend Child Process (`electron/backend-manager.ts` -> `utilityProcess.fork('dist-electron/server.mjs')`)**:
   - Runs inside Electron's embedded Node.js runtime (`NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=0`, `VDS_DESKTOP_MODE=1`) — **no external Node.js installation required** by desktop end users.
   - Emits `VDS_SERVER_READY:{port}` and `process.parentPort` `ready` signal; accepts `shutdown` IPC message cleanly.

## 2. User Data Directory Layout (`%APPDATA%\Visual Database Studio`)
- `data/control-plane.db`: Local SQLite control-plane metadata (workspaces, connections, snapshots, change plans, audit logs).
- `data/sandbox-northwind.db`: Optional `NorthwindOps_Sample` learning sandbox database.
- `master.key.dpapi`: AES-256-GCM master encryption key protected via Electron `safeStorage` (Windows DPAPI scoped to current OS user).
- `preferences.json`: Persisted theme, Simple/Developer mode, sidebar width, and recent connection IDs.
- `window-state.json`: Multi-monitor clamped window coordinates and maximized state.
- `logs/app.log`: Sanitized application & backend lifecycle logs.
