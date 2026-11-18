# Desktop Edition Installation & Usage Guide (Windows)

## Supported Operating Systems
- Windows 11 (x64)
- Windows 10 (x64)
- Windows Server 2019, 2022, and 2025 (x64)

## End-User Installation (No Manual Node.js Required)
Electron packages its embedded Node.js runtime, Chromium UI, Express backend (`dist-electron/server.mjs`), and SQLite control-plane engine inside the installer:

### Option A: Windows Installer (`VisualDatabaseStudio-Setup-1.0.0.exe`)
1. Run `VisualDatabaseStudio-Setup-1.0.0.exe` (per-user `%LOCALAPPDATA%\Programs` install by default — no system-wide admin lockouts).
2. Choose installation directory if desired and complete the wizard.
3. Launch **Visual Database Studio** from the Start Menu or Desktop shortcut.
4. To uninstall cleanly, use **Windows Settings -> Apps -> Installed apps -> Visual Database Studio -> Uninstall**. User data in `%APPDATA%\Visual Database Studio` can optionally be wiped beforehand via **Edition Info -> Delete All Local Data**.

### Option B: Portable Executable (`VisualDatabaseStudio-Portable-1.0.0.exe`)
1. Copy `VisualDatabaseStudio-Portable-1.0.0.exe` to any local folder on Windows.
2. Double-click to launch directly without installation.

## Native Desktop Features
- **Menu Bar**: `File` (`Ctrl+N` New Connection, `Ctrl+O` Connection Manager, `Ctrl+T` Create Table, Import/Export), `Edit` (`Ctrl+K` Quick Jump), `Database` (`Ctrl+Shift+D` Detect Local SQL, `F5` Refresh Schema, `Ctrl+Shift+Q` New Query), `View` (Simple/Developer Mode, Light/Dark Theme, Fullscreen), `Tools` (Application Logs, Audit, Change Center), `Help` (`Ctrl+/` Shortcuts, Updates, Diagnostics).
- **Native Windows File Dialogs**: Import `.csv`/`.xlsx` files and export `.csv`, `.xlsx`, and ER `.svg` diagrams using native Windows Explorer pickers.
- **Persistent State**: Sidebar width, Simple/Developer mode, Light/Dark preference, recent connections, and multi-monitor window bounds persist across restarts.
