# Windows Connector Agent (`agent/`) Guide

The **Windows Connector Agent** is a standalone Node.js service built for **Windows 11** and **Windows Server** that enables:
1. Consent-gated local SQL Server instance discovery from remote or containerized Visual Database Studio backends.
2. Private network tunneling to localhost or corporate LAN SQL Server instances with zero inbound firewall openings.
3. Windows Integrated Authentication (NTLM) and SQL Authentication execution close to the target server.

## Architecture & Protocol

- **Transport**: Outbound WebSocket connection to `<APP_URL>/agent-ws` (e.g., `ws://localhost:3000/agent-ws` or `wss://studio.example.com/agent-ws`).
- **Pairing Authentication**: One-time token (`vds_pair_...`) hashed server-side via SHA-256. Tokens remain valid only while the agent is not revoked by a Workspace Owner/Admin.
- **Administrator Approval Gate**: Newly connected agents enter `pending_approval` state; an Owner/Admin must click **Approve** in **Connections** before RPC SQL execution is permitted.
- **Revocation**: Clicking **Revoke** immediately blocks RPC calls and instructs the agent gateway to disconnect the socket on heartbeat/auth.
- **RPC Methods**:
  - `discover_instances`: Returns Windows Service, Registry, SQL Browser UDP `1434`, and TCP reachability metadata.
  - `test_connection`: Runs 4-step connectivity/TLS/auth/permission probe from the Windows host.
  - `list_databases`, `get_database_properties`, `create_database`, `rename_object`
  - `introspect`, `get_dependencies`, `browse_rows`, `insert_row`, `update_row`, `delete_rows`, `bulk_update`, `execute_query`, `apply_operations`

## Installation on Windows 11 / Windows Server

### Interactive Run (Quick Test)

```powershell
cd agent
npm install
npm run build
$env:VDS_SERVER_WS_URL="ws://localhost:3000/agent-ws"
$env:VDS_PAIRING_TOKEN="vds_pair_generated_from_ui"
npm run start
```

### Persistent Background Service Install (Administrator PowerShell)

```powershell
cd agent
powershell -ExecutionPolicy Bypass -File .\scripts\install-service.ps1 `
  -PairingToken "vds_pair_generated_from_ui" `
  -ServerWsUrl "ws://localhost:3000/agent-ws"
```

This builds `agent/dist/`, writes `agent/.env.agent`, creates `agent/run-agent.cmd`, and registers a Windows Scheduled Task (`VisualDatabaseStudioAgent`) set to launch at system startup and restart automatically on failure.

### Uninstalling the Background Service

```powershell
cd agent
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-service.ps1
```

Removes the `VisualDatabaseStudioAgent` scheduled task and deletes `agent/.env.agent`.

## Security Considerations

- Never commit `.env.agent` or `vds_pair_*` tokens to Git.
- Always use `wss://` (TLS) when connecting an agent across untrusted or public networks.
- On the SQL Server host, grant the agent's SQL login only the minimum required database privileges.
