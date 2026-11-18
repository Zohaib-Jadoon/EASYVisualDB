# Visual Database Studio

Visual Database Studio is a commercial-grade Microsoft SQL Server visual management, modeling, query, and governed change-management workspace designed for Windows 11 localhost use, remote SQL Server / Azure SQL environments, and private networks via the Windows Connector Agent.

## Key Capabilities

- **SQL Server Connections & Discovery**:
  - Consent-gated **Detect Local SQL Servers** (Windows Service + Registry + SQL Browser UDP `1434` + TCP port reachability) directly on Windows hosts or via a paired **Windows Connector Agent**.
  - Support for SQL Server Authentication, Windows Integrated Auth (`domain\user`), Microsoft Entra ID, explicit TLS (`encrypt` / `trustServerCertificate` — never silently bypassed), named instances, custom timeouts, startup auto-reconnect, and default Read-Only Explorer mode.
- **Database Management & Tables**:
  - Browse server databases (`sys.databases`), inspect properties, create new databases (on SQL Server connections), safely rename tables/columns (`sp_rename`), inspect foreign-key & view expression dependencies (`sys.sql_expression_dependencies`), and build/alter columns, primary keys, unique constraints, and indexes.
- **Visual Database Designer (`@xyflow/react`)**:
  - Interactive ER diagram auto-layout, column-to-column foreign key creation, click-edge constraint drop staging, schema validation, full T-SQL preview, persistent diagram coordinates, and SVG export.
- **Records Management**:
  - Server-side paginated grid (`OFFSET / FETCH`), column sorting, search + structured column filter builder, inline optimistic-concurrency edits, bulk row updates, controlled PK deletions, and `.csv` / `.xlsx` import & export.
- **SQL Tools**:
  - Visual Query Builder (joins, filters, `GROUP BY`, aggregates, sorting), parameterized SQL Editor, `Format SQL`, configurable timeout & max-row caps, saved scripts, query history, and SQL Server error diagnostics.
- **Change Center & Audit Trail**:
  - Draft -> Validated -> Pending Approval -> Approved -> Executed lifecycle, separation-of-duties approval checks, live schema drift comparison, plan revalidation/discard, and append-only redacted audit logs.
- **Opt-In AI Assistant**:
  - Natural-language schema drafting, read-only `SELECT` SQL generation, step-by-step SQL explanations, FK relationship suggestions, and deterministic/Gemini Markdown database documentation (no customer table row data transmitted).
- **Optional SQLite Learning Sandbox**:
  - Isolated `NorthwindOps_Sample` SQLite sandbox clearly separated via backend adapter architecture (`SandboxAdapter` vs `MssqlAdapter` vs `AgentTunnelAdapter`) so you can explore UI workflows offline without an external SQL Server.

## Quick Start on Windows 11 (Localhost)

Requires **Node.js 22 LTS** (native `node:sqlite` support).

```powershell
git clone https://github.com/Zohaib-Jadoon/visualDB-studio.git
cd visualDB-studio
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
.\scripts\start-dev.ps1
```

Open `http://localhost:3000`.

## Documentation Index

- `docs/LOCALHOST_SETUP.md` — Complete Windows 11 & developer environment guide
- `docs/SQL_SERVER_CONNECTIONS.md` — Local, LAN, Remote Windows Server, Azure SQL & TLS guide
- `docs/WINDOWS_AGENT.md` — Windows Connector Agent protocol, installation & service management
- `docs/ARCHITECTURE.md` — Control-plane vs data-plane adapters & schema separation
- `docs/SECURITY.md` — RBAC, tenant isolation, credential vault & SQL guardrails
- `docs/FEATURE_CHECKLIST.md` — Feature verification matrix
- `docs/TEST_REPORT.md` — Automated test coverage & pending live SQL Server verification items
- `docs/ROADMAP.md` — Post-v1 commercial & enterprise roadmap
- `docs/MEMORY.md` — Engineering state summary
