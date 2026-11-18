# Product & Engineering Roadmap — Visual Database Studio

## Completed in v1.0 (Current Codebase — Web & Desktop Editions)
- **Web Edition**: React 19 + Vite + Express + WebSocket Gateway + `node:sqlite` Control Plane + Windows Connector Agent (`agent/`).
- **Electron Desktop Edition (`electron/`)**: Complete Windows x64 desktop wrapper bundling backend (`dist-electron/server.mjs`) via Electron `utilityProcess.fork`, Windows DPAPI key sealing (`safeStorage`), per-launch `127.0.0.1` loopback security token, native Windows menus, native Open/Save dialogs, multi-monitor bounds clamping, sanitized file logs, and NSIS + Portable `electron-builder.yml` packaging config.
- **Unified SQL Server Adapter (`src/lib/db/sqlserver.ts`)**: `SqlServerAdapter` with schema discovery, T-SQL execution, connection health checks, honest Windows Integrated Auth (`msnodesqlv8` vs NTLM) capability inspection, and structured error classification.
- **Full-Stack Modules**: Overview, Connections & Local Discovery, Database Explorer, Table Builder, Records Grid (`OFFSET/FETCH` + CSV/Excel import/export), Visual ER Designer (`@xyflow/react`), Query Builder & SQL Editor, Change Center, AI Assistant, Audit Log, and Team/Billing Control Plane.

## Next Stage (Stage 2 — Live Windows 11 Packaging & SQL Server Verification)
- Run `npm run desktop:dist` on Windows 11 (or Wine/NSIS build host) to generate and smoke-test `VisualDatabaseStudio-Setup-1.0.0.exe` and `VisualDatabaseStudio-Portable-1.0.0.exe`.
- Verify live Desktop Electron window launch, DPAPI `master.key.dpapi` encryption, native file dialogs, and local Windows SQL Server Developer/Express discovery & TLS/NTLM connections on Windows 11.
- Validate Windows Connector Agent (`agent/`) as a Windows Task Scheduler / Windows Service against private network SQL Server hosts.

## Commercial v1.1+ Enhancements
- Optional prebuilt `msnodesqlv8` native binary packaging + Microsoft ODBC Driver 18 prerequisite check for passwordless Windows Integrated Security (`Trusted_Connection=yes`).
- Authenticode EV / Azure Trusted Signing integration for signed installer `.exe` binaries and signed HTTPS `latest.yml` auto-update feed (`DesktopUpdater`).
- Enterprise SAML 2.0 / OIDC SSO and automated SQL Server 2022 container integration CI pipeline.
