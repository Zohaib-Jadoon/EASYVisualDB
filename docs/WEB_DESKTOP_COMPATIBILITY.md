# Web Edition & Desktop Edition Parity Matrix

Both editions share the exact same React 19 UI (`src/App.tsx`, `src/components/*`), pure T-SQL compiler (`src/shared/sqlCompiler.ts`), RBAC engine (`src/shared/permissions.ts`), SQLite control plane (`src/server/controlPlane.ts`), and `SqlServerAdapter` (`src/lib/db/sqlserver.ts`).

| Capability | Web Edition (Browser + Node Server) | Windows Desktop Edition (Electron x64) |
| :--- | :--- | :--- |
| **User Runtime Requirement** | Browser + Node.js 22+ server (`npm run dev` / `npm start`) | Self-contained `.exe` installer/portable (embedded Node runtime) |
| **Control-Plane Storage** | Local `./data/control-plane.db` (or `VDS_DATA_DIR`) | `%APPDATA%\Visual Database Studio\data\control-plane.db` |
| **Vault Master Key** | Environment `VDS_MASTER_KEY` / server file key | Windows DPAPI (`safeStorage`) sealed `master.key.dpapi` |
| **Loopback Security** | Session cookie + RBAC + tenant headers | `127.0.0.1` ephemeral port + per-launch `x-vds-desktop-token` + Origin guard |
| **Native Windows Menu** | In-app sidebar, command palette (`Ctrl+K`), keyboard shortcuts (`Ctrl+/`) | Full native `File`, `Edit`, `Database`, `View`, `Tools`, `Help` menu + shortcuts |
| **CSV / Excel / SVG I/O** | Browser `<input type="file">` & Blob download | Native Windows Explorer Open/Save dialogs (`desktopBridge.ts`) |
| **Local SQL Discovery** | Via Node host on Windows or Windows Connector Agent (`agent/`) | Direct from Windows Desktop host (plus Windows Connector Agent for remote LAN/VPC) |
| **Offline Drafting & UI** | Full schema design, T-SQL compiler, SQLite sample sandbox | Full schema design, T-SQL compiler, SQLite sample sandbox + window/sidebar persistence |
| **Auto-Update** | Standard Git/server deployment | Disabled unless signed HTTPS update feed is configured (`DesktopUpdater`) |
