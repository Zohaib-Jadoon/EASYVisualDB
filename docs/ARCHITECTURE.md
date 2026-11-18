# Visual Database Studio — Architecture Overview

## Runtime Topology
- **Frontend (`src/`)**: React 19 + TypeScript + Tailwind CSS v4 SPA featuring dual Simple/Developer experience modes, React Flow ER diagramming (`@xyflow/react`), TanStack Table spreadsheet data grid (`@tanstack/react-table`), and Lucide iconography.
- **Backend (`server.ts` & `src/server/`)**: Express REST API mounted alongside Vite dev middleware (and static `dist/` serving in production) on port `3000`.
- **Control Plane (`data/control-plane.db`)**: Separate SQLite store holding workspaces, RBAC members, encrypted connection references, schema metadata snapshots, change plans, append-only audit logs, Windows agent pairing records, saved queries, and subscription entitlements. Never stores customer business table rows.
- **Data Plane Adapters**:
  - `src/server/mssqlConnector.ts`: Real Microsoft SQL Server / Azure SQL connector via `mssql` with 4-step connection diagnostics, TLS certificate validation, catalog view introspection, server-side pagination, and transactional DDL execution.
  - `src/server/sandboxDb.ts`: Explicit opt-in local relational SQLite sandbox (`NorthwindOps_Sample`) supporting real relational tables, keys, CRUD with optimistic concurrency, DDL, and SQL querying for evaluation without an exposed SQL Server.

## Shared Pure Logic (`src/shared/`)
- `sqlCompiler.ts`: Identifier allowlist validation, bracket/quote escaping, typed AST compilation (`CREATE TABLE`, `ADD COLUMN`, `DROP COLUMN`, `DROP TABLE`, `ADD FOREIGN KEY`, `CREATE INDEX`), parameterized `VisualQuerySpec` builder, and ad-hoc SQL safety validation.
- `permissions.ts`: Stricter-wins dual authorization across workspace RBAC, connection `readOnly` state, SQL Server capabilities, separation-of-duties approval checks, TOCTOU schema fingerprint matching, and plan entitlements.
