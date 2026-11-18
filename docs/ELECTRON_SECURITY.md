# Electron Desktop Security Model

Visual Database Studio Desktop Edition enforces defense-in-depth isolation across every boundary:

## 1. Renderer & WebPreferences Hardening (`electron/window-manager.ts`)
- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- `webSecurity: true`
- `allowRunningInsecureContent: false`
- `webviewTag: false` (`will-attach-webview` also explicitly prevented)
- Browser permission requests (`camera`, `microphone`, `geolocation`, `notifications` web APIs) are unconditionally denied via `session.defaultSession.setPermissionRequestHandler`.

## 2. Content Security Policy (CSP) & Navigation Lockdown
- `buildDesktopCsp()` injects restrictive CSP headers (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, `script-src 'self'` in packaged builds).
- `will-navigate` restricts the main window strictly to the per-launch `http://127.0.0.1:<port>` origin.
- `setWindowOpenHandler` denies child Electron windows and permits opening external links only if `isSafeExternalUrl()` confirms `https:` protocol (`file:`, `javascript:`, `http:` blocked).

## 3. Loopback Backend Authentication (`server.ts` & `electron/security.ts`)
- When `VDS_DESKTOP_MODE=1`, the bundled backend binds exclusively to `127.0.0.1` on an OS-assigned ephemeral port (`PORT=0`).
- Every `/api/*` request (except `/api/health`) MUST present:
  - Matching per-launch 256-bit `x-vds-desktop-token` (verified with `crypto.timingSafeEqual`).
  - Allowed `Origin` header (`127.0.0.1` or `localhost`, blocking cross-site browser attacks).

## 4. IPC Sender Validation & Credential Protection
- Every `ipcMain.handle` asserts caller frame URL origin matches the desktop app origin (`validateIpcSender`).
- `master.key.dpapi` seals the vault key using Windows DPAPI (`safeStorage.encryptString` / `decryptString`).
- All logs pass through `sanitizeLogLine()` to redact passwords, connection strings, and `x-vds-desktop-token`.
- Users can erase all local control-plane metadata, DPAPI keys, preferences, and sandbox files via **Edition Info -> Delete All Local Data** without touching external SQL Server databases.
