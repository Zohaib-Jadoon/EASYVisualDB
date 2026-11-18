# Project Memory — Visual Database Studio

## Current State
- **Architecture**: Full-stack Express (`server.ts`) + React 19 / Vite + Tailwind v4 + `node:sqlite` Control Plane + `mssql` SQL Server connector + local `NorthwindOps_Sample` relational sandbox.
- **Implemented Modules**:
  - Multi-tenant Workspaces, RBAC (`Owner`, `Admin`, `Designer`, `Data Editor`, `Viewer`), and Plan Entitlements (`Free`, `Pro`, `Team`, `Enterprise`).
  - SQL Server Connection Wizard with 4-step diagnostics (`reachability`, `tls`, `authentication`, `permissions`), AES-256-GCM secret storage, secret rotation, and Windows Connector Agent pairing tokens.
  - Database Explorer & No-Code Table Builder (`Simple` and `Developer` modes) with live T-SQL preview and preflight checks.
  - Visual Database Designer (`@xyflow/react`) with interactive column-to-column FK linking, layout persistence, and SVG export.
  - Spreadsheet Records Grid with server-side 50-row pagination, sorting, search, typed inserts, optimistic concurrency inline updates, controlled PK deletes, and CSV import/export.
  - Visual Query Builder & SQL Editor with parameterized queries, saved scripts, and query history.
  - Change Center (`Draft -> Validated -> Pending Approval -> Approved -> Executed`) with separation-of-duties and destructive confirmation phrases.
  - Opt-in Gemini AI Assistant (`gemini-4-hydrogen`) for schema drafting and read-only NL-to-SQL.
  - Append-only redacted Audit & Activity History.

## Verification Status
- Pure-logic unit tests (`src/shared/sqlCompiler.test.ts`, `src/shared/permissions.test.ts`): **11/11 passing** via `npx --yes tsx --test`.
- TypeScript & Vite build: `compile_applet` and `lint_applet` (`tsc --noEmit`) passing with 0 errors.
- Browser E2E verification (`playwright-cli` at `1440x900` Light/Dark and `390x844` Mobile): verified Honest Empty State, Interactive Sample Sandbox mount, Connection Read-Only -> Read-Write toggle, Table Builder -> Change Center transactional execution, Visual Designer (`@xyflow/react` smoothstep ER graph), Records grid, Visual Query Builder, SQL Editor, Database Explorer, AI Assistant, Audit & History, Team & Billing, and mobile drawer navigation with 0 console errors and 0 horizontal overflow.

## Pending / Future Production Hardening
- Native signed `.msi` Windows Connector Agent binary (pairing/revocation control plane is implemented).
- Live payment webhook integration (Stripe/regional processor adapter) for commercial billing checkout.
- Automated SQL Server 2019/2022/2025 Docker test fixture matrix in CI.
