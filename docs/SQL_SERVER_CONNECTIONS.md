# Microsoft SQL Server Connections Guide

Visual Database Studio connects to Microsoft SQL Server across four supported topologies without requiring you to expose SQL Server publicly to the internet.

## 1. Local SQL Server on the Same Windows 11 Computer

1. Ensure Microsoft SQL Server (Developer, Express, or Standard) is installed on Windows 11.
2. Open **SQL Server Configuration Manager**:
   - Expand **SQL Server Network Configuration -> Protocols for `<INSTANCE>`**.
   - Enable **TCP/IP**.
   - If using a named instance (e.g., `SQLEXPRESS`), ensure **SQL Server Browser** service is running in `services.msc`.
   - Restart the SQL Server service after protocol changes.
3. In Visual Database Studio -> **Connections**, click **Detect Local SQL Servers**:
   - Instances found via Windows Services, Registry, and UDP `1434` appear with availability badges.
   - Click an available instance to pre-populate the Connection Wizard.
   - Supply SQL Authentication (`sa` / least-privilege SQL login) or Windows Authentication credentials and click **Test Connection** to retrieve accessible databases.

## 2. Other Computers on Your Local Network (LAN) & Remote Windows Servers

1. On the target SQL Server host, enable **TCP/IP** and open Windows Defender Firewall inbound rule for TCP `1433` (or the instance's fixed port; plus UDP `1434` if resolving named instances by name) scoped strictly to trusted LAN/VPN subnets.
2. In **Connections -> Direct / Local TCP**:
   - **Host / IP**: e.g., `192.168.1.50` or `sql-srv-01.corp.local`
   - **Instance Name**: optional (e.g., `SQLEXPRESS` or leave blank for default port `1433`)
   - **Port**: `1433` (ignored automatically when resolving a dynamic named instance via SQL Browser)
   - **TLS Encryption**: enabled by default. Only check **Explicitly Trust Self-Signed Cert** on trusted dev/self-signed servers; Visual Database Studio never silently disables certificate verification.

## 3. Private Networks via Windows Connector Agent (Zero Inbound Ports)

When SQL Server sits behind NAT, a corporate firewall, or on a remote Windows machine where opening inbound port `1433` is undesirable:
1. Generate a pairing token in **Connections -> Windows Agent**.
2. Run `agent/` on a Windows host that has private network visibility to SQL Server (`localhost` or LAN IP).
3. Approve the paired agent, then choose **Windows Agent** mode in the Connection Wizard. All diagnostics, queries, and transactions tunnel securely over outbound WebSocket (`/agent-ws`).

## 4. Azure SQL Database

1. Select **Azure SQL** in the Connection Wizard.
2. Enter your logical server FQDN (e.g., `myserver.database.windows.net`), port `1433`, target database name, and credentials (SQL Auth or Microsoft Entra ID with `AZURE_CLIENT_ID`/`AZURE_TENANT_ID` set in `.env`).
3. Keep **Require Encrypted TLS Transport** checked and **Explicitly Trust Self-Signed Cert** unchecked so Azure SQL's public TLS certificate chain is strictly verified.

## 5. Authentication & Least-Privilege Recommendations

- New connections save in **Read-Only (Explorer)** mode by default so accidental edits cannot occur.
- Grant application/viewer accounts only `VIEW DEFINITION` + `SELECT` for read-only exploration, and use dedicated accounts with `ALTER` / `CREATE TABLE` only when executing approved Change Center plans.
- Passwords are encrypted at rest using AES-256-GCM (`VDS_MASTER_KEY` or `data/.vds-master.key`) and never returned to browser clients.
