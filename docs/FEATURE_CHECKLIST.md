# Feature Checklist — Visual Database Studio

Status Legend: `[x]` Implemented & verified (Code + Automated tests / Browser checks) | `[P]` Implemented in codebase; requires Windows 11 Desktop / live SQL Server host validation.

## 1. Local & Remote SQL Server Discovery & Connections (`src/lib/db/sqlserver.ts`)
- [x] Dedicated `SqlServerAdapter` (`src/lib/db/sqlserver.ts`) with schema discovery, T-SQL execution, health checks, error classification, and pool cleanup
- [x] Consent-gated **Detect Local SQL Servers** panel & `/api/discovery/local-sql` endpoint
- [P] Local Windows Service (`MSSQLSERVER`, `MSSQL$*`), Registry & SQL Browser UDP `1434` discovery on Windows 11/Server
- [x] Direct TCP/TLS, Named Instance (`SERVER\INSTANCE`), Azure SQL, and Windows Agent connection modes
- [x] Authentication methods: SQL Auth, Windows Integrated NTLM (`domain\user`), Microsoft Entra ID (`entra_id`), honest SSPI (`msnodesqlv8`) capability reporting
- [x] Explicit TLS / `trustServerCertificate` toggle (never silently disabled)
- [x] Connection timeout (`timeoutMs`) and startup auto-reconnect (`reconnectOnStartup`)
- [x] 4-step live connection diagnostics & database dropdown populated on Test Connection
- [x] AES-256-GCM credential encryption at rest + secret rotation

## 2. Windows Electron Desktop Edition (`electron/`)
- [x] Electron `45.3.4` main/preload/utilityProcess bundled Node architecture (`scripts/build-desktop.mjs` -> `dist-electron/`)
- [x] Secure `BrowserWindow` isolation (`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, restrictive CSP, external URL blocking)
- [x] Loopback `127.0.0.1` + ephemeral port (`PORT=0`) + per-launch `x-vds-desktop-token` + origin header enforcement
- [x] Windows DPAPI (`safeStorage`) master key storage & local desktop data wipe flow
- [x] Native Windows menu bar (`File`, `Edit`, `Database`, `View`, `Tools`, `Help`) dynamically synced with workspace/connection/RBAC state
- [x] Native Windows File Open/Save dialogs for CSV/Excel import/export and SVG ER diagram export
- [x] Multi-monitor window position/size persistence (`clampWindowBounds`) + resizable desktop sidebar + persisted theme/mode/recent connections
- [x] Sanitized logs viewer (`logs/app.log`), Keyboard Shortcuts reference modal (`Ctrl+/`), Edition & Diagnostics modal
- [P] Windows x64 NSIS (`Setup.exe`) & Portable (`Portable.exe`) installer build & live Windows 11 GUI launch (`electron-builder.yml`)

## 3. Core Database Management Modules (Shared Across Web & Desktop)
- [x] Database Dashboard & Overview (connection health, stats, audit feed, disconnected empty state)
- [x] Database Explorer (`listDatabases`, properties, `CREATE DATABASE`, `sp_rename`, dependencies)
- [x] Table Builder & DDL Designer (create table, add/alter/drop columns, PK, FK, unique constraints, indexes)
- [x] Records Management (server-side `OFFSET/FETCH` pagination, sorting, column filters, inline optimistic concurrency edit, bulk edit, CSV/Excel import & export)
- [x] Visual Database Designer (`@xyflow/react` ER canvas, FK linking, click-edge drop staging, saved layouts, T-SQL preview, SVG export)
- [x] Query Builder & SQL Editor (joins, aggregates, formatter, caps, saved queries, history, error explanations)
- [x] Change Center & Audit (staged lifecycle, separation of duties, drift diff, revalidate, redacted logs)
- [x] AI Assistant (schema draft, NL-to-SQL, explain SQL, relationship suggestions, Markdown docs)
- [x] Commercial SaaS Control Plane (auth, sessions, invitations, RBAC, tenant isolation, billing provider, migrations)
- [x] Standalone Windows Connector Agent (`agent/`)
