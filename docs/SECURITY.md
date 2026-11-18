# Security & Data Boundaries

1. **Server-Side Tenant Isolation**: Every `/api/*` endpoint enforces `x-workspace-id` and `x-actor-id` server-side against `controlPlane.getWorkspaceSummary`. Cross-tenant resource IDs return `403`/`404`.
2. **Credential Encryption**: SQL Server passwords are encrypted at rest via AES-256-GCM (`src/server/crypto.ts`) and never returned to the browser or written into audit logs.
3. **Least Privilege & Read-Only Default**: Connections default to `readOnly: true` (Explorer mode). Both SaaS RBAC and SQL Server permissions are evaluated; the stricter permission wins.
4. **SQL Injection & TOCTOU Protection**: All user-entered identifiers are validated via `^[A-Za-z_][A-Za-z0-9_]{0,127}$` and bracket-quoted. Change Plans store a SHA-256 digest and `targetFingerprint` and abort execution if the database schema changes between review and apply.
5. **Destructive Safeguards**: `DROP TABLE`, `DROP COLUMN`, and `ON DELETE CASCADE` require exact confirmation text entry and (in Production) separate-author approval.
6. **AI Privacy Gate**: Gemini integration (`src/server/aiAssistant.ts`) is strictly server-side, disabled by default, requires both `GEMINI_API_KEY` and workspace metadata consent, and never transmits customer row data.
