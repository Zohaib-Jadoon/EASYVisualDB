import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme, screen, session, shell } from 'electron';
import {
  buildDesktopCsp,
  isAllowedAppNavigation,
  isSafeExternalUrl,
} from './security';

import {
  clampWindowBounds,
  DisplayWorkArea,
  SavedWindowState,
} from './window-bounds';

export { clampWindowBounds };
export type { DisplayWorkArea, SavedWindowState };

export function loadWindowState(userDataDir: string): SavedWindowState {
  const statePath = path.join(userDataDir, 'window-state.json');
  let parsed: Partial<SavedWindowState> | null = null;
  try {
    if (fs.existsSync(statePath)) {
      parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<SavedWindowState>;
    }
  } catch {
    parsed = null;
  }
  const displays = screen.getAllDisplays().map((d) => d.workArea);
  return clampWindowBounds(parsed, displays);
}

export function saveWindowState(userDataDir: string, win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const statePath = path.join(userDataDir, 'window-state.json');
  const isMaximized = win.isMaximized();
  const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
  const payload: SavedWindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized,
  };
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // Ignore disk state write issues
  }
}

export function configureSessionSecurity(opts: {
  backendOrigin: string;
  isDev: boolean;
  devOrigin?: string;
}): void {
  const defaultSession = session.defaultSession;

  // Deny all browser permission requests (camera, microphone, geolocation, etc.)
  defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  const csp = buildDesktopCsp({
    backendOrigin: opts.backendOrigin,
    isDev: opts.isDev,
    devOrigin: opts.devOrigin,
  });

  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...(details.responseHeaders || {}) };
    if (details.url.startsWith(opts.backendOrigin) || (opts.devOrigin && details.url.startsWith(opts.devOrigin))) {
      responseHeaders['Content-Security-Policy'] = [csp];
      responseHeaders['X-Content-Type-Options'] = ['nosniff'];
    }
    callback({ responseHeaders });
  });
}

export function createMainWindow(opts: {
  userDataDir: string;
  preloadPath: string;
  iconPath?: string;
  loadingHtmlPath: string;
}): BrowserWindow {
  const initial = loadWindowState(opts.userDataDir);

  const win = new BrowserWindow({
    x: initial.x,
    y: initial.y,
    width: initial.width,
    height: initial.height,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'Visual Database Studio',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B0F1E' : '#F7F8FC',
    icon: opts.iconPath && fs.existsSync(opts.iconPath) ? opts.iconPath : undefined,
    webPreferences: {
      preload: opts.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  if (initial.isMaximized) {
    win.maximize();
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  const persist = () => saveWindowState(opts.userDataDir, win);
  win.on('resized', persist);
  win.on('moved', persist);
  win.on('close', persist);

  win.loadFile(opts.loadingHtmlPath).catch(() => undefined);

  return win;
}

export function attachNavigationGuards(win: BrowserWindow, allowedOrigin: string): void {
  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedAppNavigation(targetUrl, allowedOrigin)) {
      event.preventDefault();
      if (isSafeExternalUrl(targetUrl)) {
        shell.openExternal(targetUrl).catch(() => undefined);
      }
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch(() => undefined);
    }
    return { action: 'deny' };
  });

  // Never allow unexpected <webview> attachment
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

export function resolveDesktopAssetsPaths(): {
  preloadPath: string;
  loadingHtmlPath: string;
  iconPath: string;
} {
  const appPath = app.getAppPath();
  return {
    preloadPath: path.join(appPath, 'dist-electron', 'preload.cjs'),
    loadingHtmlPath: path.join(appPath, 'electron', 'loading.html'),
    iconPath: path.join(appPath, 'electron', 'assets', 'icon.png'),
  };
}
