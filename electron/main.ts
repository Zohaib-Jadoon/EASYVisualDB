import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import { DesktopBackendManager, resolveBundledPaths } from './backend-manager';
import { registerDesktopIpcHandlers } from './ipc/handlers';
import { DesktopMenuManager } from './menu';
import { DesktopUpdater } from './updater';
import {
  attachNavigationGuards,
  configureSessionSecurity,
  createMainWindow,
  resolveDesktopAssetsPaths,
} from './window-manager';

const isDevMode = process.env.VDS_ELECTRON_DEV === '1';
const devFrontendUrl = process.env.VDS_DEV_URL || '';

// Ensure AppUserModelId for Windows taskbar grouping and native notifications
if (process.platform === 'win32') {
  app.setAppUserModelId('com.visualdatastudio.desktop');
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let backend: DesktopBackendManager | null = null;
  let menuManager: DesktopMenuManager | null = null;
  let isQuitting = false;

  const gracefulQuit = async () => {
    if (isQuitting) return;
    isQuitting = true;
    try {
      if (backend) {
        await backend.stop();
      }
    } finally {
      app.exit(0);
    }
  };

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  process.on('uncaughtException', (err) => {
    backend?.appendLog('ERROR', `Uncaught main-process error: ${err.stack || err.message}`);
  });

  process.on('unhandledRejection', (reason) => {
    backend?.appendLog('ERROR', `Unhandled main-process rejection: ${String(reason)}`);
  });

  app.whenReady().then(async () => {
    const userDataDir = app.getPath('userData');
    backend = new DesktopBackendManager(userDataDir);
    const assetPaths = resolveDesktopAssetsPaths();
    const bundledPaths = resolveBundledPaths();

    menuManager = new DesktopMenuManager(
      () => mainWindow,
      () => {
        void gracefulQuit();
      }
    );
    menuManager.install();

    const updater = new DesktopUpdater({
      currentVersion: app.getVersion(),
      isCriticalDatabaseWorkActive: () => Boolean(menuManager?.getState().hasCriticalOperationRunning),
    });

    mainWindow = createMainWindow({
      userDataDir,
      preloadPath: assetPaths.preloadPath,
      iconPath: assetPaths.iconPath,
      loadingHtmlPath: assetPaths.loadingHtmlPath,
    });

    let backendUrl = 'http://127.0.0.1';
    registerDesktopIpcHandlers({
      getWindow: () => mainWindow,
      getAllowedOrigin: () => (isDevMode && devFrontendUrl ? new URL(devFrontendUrl).origin : backendUrl),
      backend,
      menu: menuManager,
      updater,
    });

    try {
      const started = await backend.start({
        serverEntryPath: bundledPaths.serverEntryPath,
        staticDir: bundledPaths.staticDir,
      });
      backendUrl = started.url;

      const devOrigin = isDevMode && devFrontendUrl ? new URL(devFrontendUrl).origin : undefined;
      configureSessionSecurity({
        backendOrigin: started.url,
        isDev: isDevMode,
        devOrigin,
      });

      const targetUrl = isDevMode && devFrontendUrl ? devFrontendUrl : started.url;
      attachNavigationGuards(mainWindow, new URL(targetUrl).origin);

      const healthy = await backend.checkHealth();
      if (!healthy) {
        throw new Error('Bundled backend failed post-start health verification.');
      }

      await mainWindow.loadURL(targetUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      backend.appendLog('ERROR', `Startup failure: ${msg}`);
      dialog.showErrorBox(
        'Visual Database Studio — Startup Error',
        `Failed to start the local database studio backend.\n\n${msg}\n\nLog file: ${path.join(userDataDir, 'logs', 'app.log')}`
      );
      await gracefulQuit();
    }

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  });

  app.on('before-quit', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      if (menuManager?.getState().hasCriticalOperationRunning) {
        backend?.appendLog('INFO', 'Deferring quit cleanly to drain active database operation.');
      }
      void gracefulQuit();
    }
  });

  app.on('window-all-closed', () => {
    void gracefulQuit();
  });
}
