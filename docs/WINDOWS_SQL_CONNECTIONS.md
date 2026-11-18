# Windows SQL Server Connections & Authentication Guide

## 1. Local & Network Connection Topologies
Visual Database Studio Desktop Edition connects directly from the Windows workstation without requiring Node.js installation:

- **Same Windows PC (Default Instance)**: `localhost` or `127.0.0.1`, port `1433` (`MSSQLSERVER` service).
- **Same Windows PC (Named Instance)**: `localhost\SQLEXPRESS`, `.\MSSQLSERVER01`, or `(local)\INSTANCENAME`. Ensure **SQL Server Browser** service (`UDP 1434`) is running, or specify the instance's static TCP port explicitly.
- **Local LAN / Remote Windows Server**: Hostname or IP address, port `1433` (or custom port), TLS enabled.
- **Azure SQL Database**: `<server>.database.windows.net`, port `1433`, `Encrypt TLS = ON`, `Trust Server Certificate = OFF`.
- **Private Networks via Windows Connector Agent**: Install `agent/` on a host inside the private VPC/LAN; outbound WebSocket tunnel requires zero inbound port `1433` exposure.

## 2. Authentication Methods (Honest Behavior)
- **SQL Server Authentication**: Supply SQL login username & password (`sa` or least-privilege app login).
- **Windows Authentication (NTLM)**: Supported directly cross-platform and on Windows when explicit `Domain` (or `DOMAIN\username`) and `Password` are provided (`tedious` NTLM provider).
- **Passwordless Windows Integrated Security (SSPI / Kerberos)**: Requires the native `msnodesqlv8` C++ addon and **Microsoft ODBC Driver 17 or 18 for SQL Server** installed on Windows x64. Visual Database Studio inspects runtime driver availability (`inspectWindowsIntegratedDriverSupport()`) and reports status honestly in Connections — it **never** silently downgrades or falls back to SQL Auth when SSPI drivers are absent.
- **Microsoft Entra ID**: Configured via `entra_id` auth mode.

## 3. TLS & Certificate Guardrails
- Production and Azure SQL connections default to `encrypt: true` and `trustServerCertificate: false`.
- Local development instances using self-signed SQL Server certificates fail explicitly with `tls_certificate_failed` diagnostics unless the user intentionally enables **"Trust Self-Signed Certificate (Local Dev Only)"** in the connection wizard. Certificate validation is never silently bypassed.
