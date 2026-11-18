# Visual Database Studio — Windows Connector Agent

Standalone outbound connector service (`agent/`) for **Windows 11** and **Windows Server**. It allows Visual Database Studio to discover local SQL Server instances, test connectivity, browse databases, introspect schemas, run parameterized queries, and execute reviewed Change Plans against private or localhost SQL Server instances without exposing TCP port `1433` to the internet.

## Capabilities

- **Local SQL Server Discovery** (`src/discovery.ts`):
  - Queries Windows Services (`MSSQLSERVER` default instance and `MSSQL$*` named instances).
  - Inspects `HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL` registry keys.
  - Sends SQL Server Browser UDP `1434` (`0x02`) discovery probes for dynamic named-instance TCP ports.
  - Verifies local TCP socket reachability and reports instance availability (`available`, `stopped`, `unreachable`).
- **Outbound WebSocket Tunnel** (`src/index.ts`):
  - Connects outbound to `ws://localhost:3000/agent-ws` (or `wss://<studio-host>/agent-ws`) using a one-time SHA-256-verified pairing token.
  - Sends periodic heartbeats with refreshed instance status.
  - Automatically reconnects with exponential backoff unless revoked by a workspace administrator.
- **SQL Server Execution** (`src/mssqlRunner.ts`):
  - Executes `test_connection`, `list_databases`, `get_database_properties`, `create_database`, `rename_object`, `introspect`, `execute_query`, and `apply_operations` over `mssql`.
  - Supports SQL Server Authentication (`sql_auth`) and Windows Integrated NTLM (`windows_integrated` with Domain, Username, and Password).
- **Windows Scheduled Service Scripts** (`scripts/install-service.ps1`, `scripts/uninstall-service.ps1`):
  - Registers a startup background task (`VisualDatabaseStudioAgent`) via PowerShell with automatic restart on failure.

## Prerequisites

- **Windows 11** or **Windows Server 2019/2022/2025**
- **Node.js 20+** (Node.js 22 LTS recommended)
- SQL Server TCP/IP protocol enabled in **SQL Server Configuration Manager** (plus **SQL Server Browser** service running if using named instances such as `.\SQLEXPRESS`)

## Interactive Console Usage (Development / Testing)

1. Open Visual Database Studio -> **Connections** -> **Windows Agent** card -> enter Agent Name & Hostname -> click **Generate Pairing Token**.
2. Copy the generated `vds_pair_...` token.
3. In PowerShell:

```powershell
cd agent
npm install
npm run build
$env:VDS_SERVER_WS_URL="ws://localhost:3000/agent-ws"
$env:VDS_PAIRING_TOKEN="vds_pair_your_token_here"
npm run start
```

4. Back in **Connections**, click **Approve** next to the newly connected agent.
5. Click **Detect Local SQL Servers** (select the paired agent) to list instances on that Windows computer.

## Installing as a Persistent Windows Background Service

Run an **Administrator PowerShell** prompt:

```powershell
cd agent
powershell -ExecutionPolicy Bypass -File .\scripts\install-service.ps1 `
  -PairingToken "vds_pair_your_token_here" `
  -ServerWsUrl "ws://localhost:3000/agent-ws"
```

## Uninstalling the Windows Service

Run an **Administrator PowerShell** prompt:

```powershell
cd agent
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-service.ps1
```

## Running Agent Unit Tests

```powershell
cd agent
npm test
```
