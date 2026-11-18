# Localhost Setup Guide (Windows 11)

Follow these instructions to install and run **Visual Database Studio** cleanly on Windows 11 against your local and remote Microsoft SQL Server databases.

## Prerequisites

- **Windows 11** (64-bit) or Windows Server 2019+
- **Node.js 22 LTS (x64)** — required for Node's built-in `node:sqlite` (`DatabaseSync`) used by the SaaS control plane and optional learning sandbox (`node -v` should show `v22.x` or newer)
- **Git for Windows**
- **PowerShell 5.1+** or **PowerShell 7+**
- Optional: **Microsoft SQL Server 2019/2022 Developer or Express Edition** + **SQL Server Management Studio (SSMS)** if testing local Windows instances

## 1. Clone & Configure Environment

```powershell
git clone https://github.com/Zohaib-Jadoon/visualDB-studio.git
cd visualDB-studio
```

Or run the automated setup script (verifies Node >= 22, installs root + `agent/` dependencies, creates `.env` from `.env.example`, runs migrations, and builds):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
```

## 2. Manual Step-by-Step Setup (Alternative)

```powershell
# Install root application dependencies
npm install

# Install & build standalone Windows Connector Agent
cd agent
npm install
npm run build
cd ..

# Copy environment template
Copy-Item .env.example .env

# Run SQLite control-plane schema migrations (creates ./data/control-plane.db)
npm run db:migrate
```

### Important `.env` Variables

- `PORT=3000` and `APP_URL="http://localhost:3000"`
- `VDS_DATA_DIR="./data"` — storage directory for `control-plane.db`, `.vds-master.key`, and optional `sandbox-northwind.db`
- `VDS_MASTER_KEY` — optional 32+ character encryption passphrase for AES-256-GCM vault & signed sessions
- `REQUIRE_LOGIN="false"` — `"false"` allows instant localhost actor switching + optional Sign In; set `"true"` to enforce cookie authentication on all workspace endpoints
- `GEMINI_API_KEY` — optional Google Gemini API key for AI schema/SQL assistance

> **Localhost Evaluation Accounts**: Migration `002` seeds demo accounts (`zainab@visualdatastudio.io`, `hamza@visualdatastudio.io`, `sara@visualdatastudio.io`, `omar@crescentretail.pk`) with default localhost evaluation password `VisualDB#2026`. Change passwords or register a fresh workspace before shared or networked deployment.

## 3. Startup & Build Commands

### One-Command Development Launcher
```powershell
.\scripts\start-dev.ps1
```
Runs `npm run db:migrate` and starts the full-stack server (`server.ts` with Express + WebSocket Gateway + Vite middleware) at **`http://localhost:3000`**.

### Standard NPM Commands
- **Development**: `npm run dev`
- **Production Build + Start**:
  ```powershell
  npm run build
  $env:NODE_ENV="production"
  npm run start
  ```
- **Or via PowerShell launcher in production mode**:
  ```powershell
  .\scripts\start-dev.ps1 -Production
  ```
- **Run Automated Tests**: `npm test`
- **Typecheck**: `npm run lint`

## 4. Offline & Disconnected Startup Behavior

Visual Database Studio boots cleanly without any SQL Server running:
- **Overview** clearly indicates the disconnected state and provides direct actions to discover/connect SQL Server or load the optional SQLite sample sandbox (`NorthwindOps_Sample`).
- Schema documentation export (Markdown), SQL formatting, RBAC policy editing, agent pairing, and query history remain accessible cleanly.
