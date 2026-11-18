# Project Memory — Visual Database Studio

## Current Engineering State
- **Dual-Edition Architecture (Web + Windows Electron Desktop)**:
  - **Web Edition**: Express + WebSocket Gateway (`server.ts`) + React 19 / Vite + Tailwind v4 + `node:sqlite` Control Plane (`data/control-plane.db`) + Data-Plane Adapters + Standalone Windows Connector Agent (`agent/`).
  - **Desktop Edition (`electron/`)**: Electron `45.3.4` (`BrowserWindow` + `preload.ts` + `utilityProcess.fork` bundled backend `dist-electron/server.mjs`) + Windows DPAPI (`safeStorage`) master key storage in `%APPDATA%\Visual Database Studio` + native Windows menus (`File`, `Edit`, `Database`, `View`, `Tools`, `Help`), native Windows file dialogs (`.csv`, `.xlsx`, `.svg`), multi-monitor window state persistence, and `electron-builder` x64 NSIS & Portable packaging config (`electron-builder.yml`). Zero manual Node.js installation required for Desktop end users.
- **Unified SQL Server Adapter (`src/lib/db/sqlserver.ts`)**:
  - `SqlServerAdapter` (`sqlServerAdapter`) implements `checkHealth()`, `discoverLocalInstances()`, `getWindowsAuthSupport()`, `introspectSchema()`, `executeTSql()`, `applySchemaOperations()`, `closeAllPools()`, structured error classification (`classifySqlServerError`), and full `DatabaseAdapter` methods.
  - `src/server/adapters/mssqlAdapter.ts` delegates directly to `sqlServerAdapter`.
  - Distinguishes honestly between Windows NTLM (`domain\user` + password via `mssql`/`tedious`) and passwordless Windows SSPI (`msnodesqlv8` + Microsoft ODBC Driver 17/18) — never silently falls back or mislabels NTLM.
- **Clean Engine Separation**:
  - Real SQL Server functionality (`SqlServerAdapter` & `AgentTunnelAdapter`) generates Microsoft SQL Server T-SQL.
  - Optional SQLite learning sandbox (`SandboxAdapter` / `NorthwindOps_Sample`) remains strictly isolated for offline exploration.

## Latest Verification Snapshot
- **Typecheck & Lint (`npm run lint`)**: `tsc --noEmit` and `tsc -p electron/tsconfig.json --noEmit` exit `0`.
- **Web + Agent Tests (`npm test`)**: **21/21 passing**.
- **Desktop & SQL Server Adapter Tests (`npm run desktop:test`)**: **10/10 passing** (Electron security/CSP/origin/redaction helpers, `clampWindowBounds`, `DesktopUpdater` verification guard, live `127.0.0.1` loopback backend auth/origin checks, `SqlServerAdapter` config/NTLM/SSPI-honesty/error classification).
- **Desktop Bundle (`npm run desktop:build`)**: Compiles `dist/` (`vite build`) and `dist-electron/{main.cjs,preload.cjs,server.mjs}`; smoke-tested booting `node dist-electron/server.mjs` in desktop loopback mode cleanly.
- **Playwright Browser Verification**: Verified Web UI on `1440x900` Light/Dark and `390x844` mobile with `0` console/network errors, including fixed mobile sidebar positioning (`fixed` on mobile, `lg:relative` on desktop), Edition Info modal, and Keyboard Shortcuts modal.
- **Pending Windows-Host Verification**: Live Electron Chromium GUI launch, Windows NSIS/Portable `.exe` build (`electron-builder --win --x64`, as Linux container lacks `wine`/`makensis` and GTK desktop libs), Windows DPAPI runtime encryption, and live SQL Server / Windows Auth / SSPI connections await execution on Windows 11.
