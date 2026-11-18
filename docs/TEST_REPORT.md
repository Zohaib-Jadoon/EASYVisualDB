# Automated Test & Verification Report

This report records the actual automated checks executed against the codebase and explicitly separates mocked/isolated unit tests from live Windows/SQL Server checks that require the user's target Windows 11 & Microsoft SQL Server environment.

## 1. Automated Test Suites (`npm test` -> `tsx --test`)

Command executed:
```bash
npx --yes tsx --test src/shared/sqlCompiler.test.ts src/shared/permissions.test.ts src/server/backend.test.ts agent/src/discovery.test.ts
```

**Result: 21 / 21 tests PASSED (exit code 0).**

### Breakdown by Suite

1. **`src/shared/sqlCompiler.test.ts` (8 tests passed)**
   - Identifier validation & SQL injection / reserved keyword rejection
   - `CREATE_TABLE` T-SQL & SQLite compilation (`INT IDENTITY`, `NVARCHAR`, `DECIMAL`, `PK CLUSTERED`)
   - `ALTER_COLUMN`, `ADD_PRIMARY_KEY`, `ADD_UNIQUE_CONSTRAINT`, `CREATE_INDEX`, `DROP_INDEX`, `RENAME_OBJECT` (`sp_rename`), `CREATE_DATABASE` T-SQL generation
   - Destructive confirmation phrase enforcement (`DROP_COLUMN`, `DROP_TABLE`, `DROP_CONSTRAINT`)
   - FK type compatibility matrix (`auto_id` <-> `integer`)
   - Parameterized `compileVisualQuery` with `INNER JOIN`, `COUNT(*)`, `GROUP BY`, bounded row limits
   - `validateSqlStatement` read-only and dangerous server command blocking (`xp_cmdshell`, multi-statement batches)
   - `formatSql`, `explainSqlError` (Error `18456`, TLS chain), `diffSchemaSnapshots`, and `generateSchemaMarkdownDocs`

2. **`src/shared/permissions.test.ts` (5 tests passed)**
   - Viewer blocked from schema & data modifications
   - Connection `readOnly: true` overrides Owner writes
   - Production separation-of-duties prevents author self-approval
   - Stale schema fingerprint (TOCTOU) and missing confirmation phrase reject Change Plan execution
   - Plan subscription quota rejects over-limit connection creation

3. **`src/server/backend.test.ts` (6 tests passed against isolated temp `VDS_DATA_DIR`)**
   - `ControlPlaneStore` applies migrations `001`–`003`, registers users (`scrypt`), verifies sessions, enforces tenant boundaries (`ws_primary` vs `ws_secondary`), validates invitation single-use tokens, and encrypts/isolates connection secrets (`AES-256-GCM`)
   - `billingProvider.verifyWebhookSignature` enforces HMAC-SHA256 webhook signatures strictly
   - `buildMssqlConfig` maps default instances, `HOST\INSTANCE` named instances, Windows Integrated NTLM domain/user, and preserves explicit `encrypt` / `trustServerCertificate` flags
   - `SandboxAdapter` explicitly rejects SQL Server-only DDL (`CREATE_DATABASE`, `ALTER_COLUMN`, `ADD_PRIMARY_KEY`, `DROP_CONSTRAINT`) while executing transactional CRUD & `bulkUpdateRows`
   - `localDiscovery` parses Windows PowerShell `Get-Service` JSON & SQL Server Browser UDP `1434` packets cleanly
   - Live localhost WebSocket round-trip against `AgentWebSocketGateway` (`/agent-ws`): agent auth, pending approval gate, admin approval, RPC request/response exchange

4. **`agent/src/discovery.test.ts` (2 tests passed)**
   - Agent Windows Service parser (`MSSQLSERVER`, `MSSQL$DEV2022`, Running/Stopped statuses)
   - Agent multi-instance SQL Browser UDP `1434` binary response parser

## 2. Build & TypeScript Verification

- `npm run lint` (`tsc --noEmit`): **PASSED (0 errors)**
- `npm run build` (`vite build`): **PASSED (production bundle compiled cleanly)**
- `npx tsc -p agent/tsconfig.json --noEmit`: **PASSED (0 errors in standalone agent)**

## 3. Browser UI Verification (`playwright-cli`)

- Verified `http://localhost:3000` across `1440x900` Light/Dark modes and `390x844` Mobile viewport.
- Verified disconnected empty state, **Detect Local SQL Servers** UI response, Sample Sandbox load, Overview health card, Database Explorer & Databases modal, Visual Designer canvas & Schema SQL preview, Table Builder, Records with Column Filters & Excel button, Query Builder & SQL Editor (`Format SQL`), AI Assistant (`Generate Standard Docs`), and Team & Billing (`Control-Plane Schema Migrations`).
- Console errors: `0` | HTTP 4xx/5xx errors: `0` | Mobile horizontal overflow: `0` (`scrollWidth === innerWidth`).

## 4. Pending Live Environment Verification (NOT Covered by Mocks)

The following behaviors **cannot** be proved by unit tests or headless Linux containers and **remain pending user verification on Windows 11 localhost**:
1. Live Windows 11 local SQL Server instance discovery (`Get-Service`, Registry, UDP `1434`) against installed SQL Server Developer/Express services.
2. Live TDS/TLS handshakes, authentication (`sql_auth`, NTLM `windows_integrated`, `entra_id`), catalog introspection, and transactional DDL execution against Microsoft SQL Server 2019/2022/2025 or Azure SQL.
3. Live Windows Scheduled Task (`install-service.ps1` / `uninstall-service.ps1`) execution and Windows Service agent heartbeat longevity under UAC/Administrator privileges.
4. Live Stripe checkout redirect & signed webhook delivery in production mode.
