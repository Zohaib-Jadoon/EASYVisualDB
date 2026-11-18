# Architecture Overview — Visual Database Studio

## 1. High-Level Dual-Edition Topology

Visual Database Studio runs from a single codebase as both a **Web Edition** (browser + local/remote Node server) and an installable **Windows Desktop Edition** (Electron `45.3.4` + bundled backend via `utilityProcess.fork`):

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Web Browser OR Electron BrowserWindow (sandbox: true, contextIsolation)    │
│   └─ Desktop only: electron/preload.ts -> window.vdsDesktop (IPC Bridge)   │
└──────────────────────────┬─────────────────────────────────────────────────┘
                           │ HTTP on 127.0.0.1:<ephemeral-port> (Desktop)
                           │   + per-launch x-vds-desktop-token + Origin guard
                           ▼
Express Server & WebSocket Gateway (server.ts / dist-electron/server.mjs)
   ├── Control Plane (src/server/controlPlane.ts + control-plane.db)
   │     ├── Workspaces, Users, Auth Sessions, Team Invitations
   │     ├── AES-256-GCM SQL Secrets (key sealed by Windows DPAPI on Desktop)
   │     ├── Schema Snapshots, Change Plans, Diagram Layouts, Audit Logs
   │     └── Paired Windows Agents & Pairing Token Hashes
   │
   ├── Shared Pure Compiler & RBAC (src/shared/)
   │     ├── sqlCompiler.ts (14 DDL ops, T-SQL & SQLite compilers, formatter, diff, docs)
   │     └── permissions.ts (Stricter-wins RBAC + Read-Only + Separation of Duties)
   │
   └── Data-Plane Adapters (src/lib/db/ & src/server/adapters/)
         ├── SqlServerAdapter (src/lib/db/sqlserver.ts) ──► Direct TDS/TLS / Azure / NTLM
         ├── AgentTunnelAdapter (/agent-ws)             ──► Windows Connector Agent
         └── SandboxAdapter                             ──► Optional SQLite learning DB
```

## 2. Electron Desktop Main/Preload Architecture (`electron/`)
- `electron/main.ts`: Single-instance lock, Windows AppUserModelId, initialization ordering, crash/exception handling, and graceful `before-quit` cleanup.
- `electron/backend-manager.ts`: Generates per-launch 256-bit desktop secret, manages `%APPDATA%\Visual Database Studio` directories, seals/unseals `VDS_MASTER_KEY` with Windows DPAPI (`safeStorage`), forks `dist-electron/server.mjs` using `utilityProcess.fork`, streams sanitized logs, and gracefully shuts down SQL pools & SQLite handles.
- `electron/window-manager.ts` + `electron/window-bounds.ts`: Multi-monitor workArea clamping, `window-state.json` persistence, permission denial, strict CSP header injection, `will-navigate` / `setWindowOpenHandler` isolation.
- `electron/menu.ts`: Context-aware Windows File/Edit/Database/View/Tools/Help native menu bar synced with React state.
- `electron/ipc/handlers.ts`: Origin-verified IPC handlers for native Open/Save dialogs, destructive confirmations, OS notifications, preferences, logs folder/tailing, DPAPI wipe, and updater status.
- `electron/updater.ts`: Disabled unless `VDS_UPDATE_FEED_URL` (HTTPS) and `VDS_UPDATE_SIGNED=true` are configured.

## 3. Data-Plane Adapter Separation (`src/lib/db/sqlserver.ts` & `src/server/adapters/`)
- **`SqlServerAdapter`** (`src/lib/db/sqlserver.ts`): Base SQL Server class implementing `checkHealth`, `discoverLocalInstances`, `getWindowsAuthSupport`, `introspectSchema`, `executeTSql`, `applySchemaOperations`, `closeAllPools`, and structured error classification. `src/server/adapters/mssqlAdapter.ts` delegates to `sqlServerAdapter`.
- **`AgentTunnelAdapter`**: Routes commands over authenticated WebSocket `/agent-ws` to a paired Windows Connector Agent inside private networks.
- **`SandboxAdapter`**: Strictly separated optional `NorthwindOps_Sample` SQLite sandbox that rejects SQL Server-only DDL operations.
