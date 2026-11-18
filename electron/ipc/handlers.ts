import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, shell } from 'electron';
import { DesktopBackendManager } from '../backend-manager';
import { DesktopMenuManager } from '../menu';
import type { DesktopMenuStatePayload, DesktopPreferences } from '../preload';
import { sanitizeDefaultFilename, validateIpcSender } from '../security';
import { DesktopUpdater } from '../updater';

export function registerDesktopIpcHandlers(deps: {
  getWindow: () => BrowserWindow | null;
  getAllowedOrigin: () => string;
  backend: DesktopBackendManager;
  menu: DesktopMenuManager;
  updater: DesktopUpdater;
}): void {
  const assertAuthorized = (event: Electron.IpcMainInvokeEvent) => {
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    if (!validateIpcSender(senderUrl, deps.getAllowedOrigin())) {
      throw new Error('Unauthorized IPC caller origin.');
    }
  };

  const readPrefs = (): DesktopPreferences => {
    try {
      const p = deps.backend.getPaths().prefsPath;
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8')) as DesktopPreferences;
      }
    } catch {
      // ignore corrupt preferences
    }
    return {};
  };

  ipcMain.handle('desktop:get-config', (event) => {
    assertAuthorized(event);
    const paths = deps.backend.getPaths();
    return {
      isDesktop: true,
      desktopToken: deps.backend.getDesktopToken(),
      apiBaseUrl: deps.backend.getApiBaseUrl(),
      platform: process.platform,
      appVersion: app.getVersion(),
      userDataDir: paths.userDataDir,
      logFilePath: paths.logFilePath,
      systemDark: nativeTheme.shouldUseDarkColors,
      dpapiProtected: deps.backend.isDpapiProtected(),
    };
  });

  ipcMain.handle('desktop:open-import-file', async (event) => {
    assertAuthorized(event);
    const win = deps.getWindow();
    const openOptions: Electron.OpenDialogOptions = {
      title: 'Import Table Records (CSV or Excel)',
      properties: ['openFile'],
      filters: [
        { name: 'Tabular Data (*.csv, *.xlsx)', extensions: ['csv', 'xlsx'] },
        { name: 'CSV Files (*.csv)', extensions: ['csv'] },
        { name: 'Excel Workbooks (*.xlsx)', extensions: ['xlsx'] },
      ],
    };
    const res = win ? await dialog.showOpenDialog(win, openOptions) : await dialog.showOpenDialog(openOptions);
    if (res.canceled || res.filePaths.length === 0) {
      return { canceled: true };
    }
    const targetPath = res.filePaths[0];
    const stat = fs.statSync(targetPath);
    if (stat.size > 15 * 1024 * 1024) {
      throw new Error('Selected import file exceeds the 15 MB safety limit.');
    }
    const ext = path.extname(targetPath).toLowerCase() === '.xlsx' ? 'xlsx' : 'csv';
    const fileName = path.basename(targetPath);
    if (ext === 'xlsx') {
      const base64 = fs.readFileSync(targetPath).toString('base64');
      return { canceled: false, fileName, ext, base64 };
    }
    const textContent = fs.readFileSync(targetPath, 'utf8');
    return { canceled: false, fileName, ext, textContent };
  });

  ipcMain.handle(
    'desktop:save-export-file',
    async (
      event,
      opts: {
        defaultName: string;
        content: string;
        encoding?: 'utf8' | 'base64';
        filters?: Array<{ name: string; extensions: string[] }>;
      }
    ) => {
      assertAuthorized(event);
      const win = deps.getWindow();
      const safeName = sanitizeDefaultFilename(opts.defaultName);
      const saveOptions: Electron.SaveDialogOptions = {
        title: 'Save Export File',
        defaultPath: path.join(app.getPath('documents'), safeName),
        filters: opts.filters,
      };
      const res = win ? await dialog.showSaveDialog(win, saveOptions) : await dialog.showSaveDialog(saveOptions);
      if (res.canceled || !res.filePath) {
        return { canceled: true };
      }
      if (opts.encoding === 'base64') {
        fs.writeFileSync(res.filePath, Buffer.from(opts.content, 'base64'));
      } else {
        fs.writeFileSync(res.filePath, opts.content, 'utf8');
      }
      return { canceled: false, filePath: res.filePath };
    }
  );

  ipcMain.handle(
    'desktop:confirm-dialog',
    async (event, opts: { title: string; message: string; detail?: string }) => {
      assertAuthorized(event);
      const win = deps.getWindow();
      const confirmOptions: Electron.MessageBoxOptions = {
        type: 'warning',
        buttons: ['Cancel', 'Confirm'],
        defaultId: 0,
        cancelId: 0,
        title: String(opts.title || 'Confirm Action'),
        message: String(opts.message || 'Proceed with this operation?'),
        detail: opts.detail ? String(opts.detail) : undefined,
      };
      const res = win ? await dialog.showMessageBox(win, confirmOptions) : await dialog.showMessageBox(confirmOptions);
      return res.response === 1;
    }
  );

  ipcMain.handle('desktop:show-notification', (event, opts: { title: string; body: string }) => {
    assertAuthorized(event);
    if (Notification.isSupported()) {
      new Notification({
        title: String(opts.title || 'Visual Database Studio'),
        body: String(opts.body || ''),
      }).show();
    }
  });

  ipcMain.handle('desktop:get-preferences', (event) => {
    assertAuthorized(event);
    return readPrefs();
  });

  ipcMain.handle('desktop:save-preferences', (event, partial: Partial<DesktopPreferences>) => {
    assertAuthorized(event);
    const current = readPrefs();
    const next: DesktopPreferences = {
      ...current,
      ...(partial.theme ? { theme: partial.theme } : {}),
      ...(partial.mode ? { mode: partial.mode } : {}),
      ...(Array.isArray(partial.recentConnectionIds)
        ? { recentConnectionIds: partial.recentConnectionIds.slice(0, 10) }
        : {}),
      ...(typeof partial.sidebarWidth === 'number'
        ? { sidebarWidth: Math.min(380, Math.max(200, partial.sidebarWidth)) }
        : {}),
    };
    fs.mkdirSync(deps.backend.getPaths().userDataDir, { recursive: true });
    fs.writeFileSync(deps.backend.getPaths().prefsPath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  });

  ipcMain.handle('desktop:open-logs-folder', async (event) => {
    assertAuthorized(event);
    const dir = deps.backend.getPaths().logsDir;
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return true;
  });

  ipcMain.handle('desktop:read-recent-logs', (event) => {
    assertAuthorized(event);
    return deps.backend.readRecentLogs(120);
  });

  ipcMain.handle('desktop:check-updates', async (event) => {
    assertAuthorized(event);
    return deps.updater.checkForUpdates();
  });

  ipcMain.handle('desktop:wipe-local-data', async (event) => {
    assertAuthorized(event);
    const win = deps.getWindow();
    const wipeOptions: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Cancel', 'Delete All Local App Data'],
      defaultId: 0,
      cancelId: 0,
      title: 'Delete Local Desktop Data',
      message: 'Remove all saved connections, DPAPI credentials, preferences, and local control-plane metadata?',
      detail: 'Customer SQL Server databases are never touched. The application will close after wiping local storage.',
    };
    const res = win ? await dialog.showMessageBox(win, wipeOptions) : await dialog.showMessageBox(wipeOptions);
    if (res.response !== 1) {
      return { wiped: false };
    }
    await deps.backend.stop();
    deps.backend.wipeLocalSensitiveData();
    app.quit();
    return { wiped: true };
  });

  ipcMain.handle('desktop:update-menu-state', (event, state: DesktopMenuStatePayload) => {
    assertAuthorized(event);
    deps.menu.updateState(state);
  });
}
