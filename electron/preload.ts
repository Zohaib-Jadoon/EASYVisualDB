import { contextBridge, ipcRenderer } from 'electron';

export type DesktopMenuCommand =
  | 'new-connection'
  | 'open-connection'
  | 'create-database'
  | 'create-table'
  | 'import-data'
  | 'export-data'
  | 'detect-local'
  | 'disconnect-active'
  | 'refresh-schema'
  | 'new-query'
  | 'open-designer'
  | 'nav-overview'
  | 'nav-explorer'
  | 'nav-designer'
  | 'nav-sql-editor'
  | 'nav-connections'
  | 'nav-changes'
  | 'nav-audit'
  | 'nav-settings'
  | 'mode-simple'
  | 'mode-developer'
  | 'theme-light'
  | 'theme-dark'
  | 'show-logs'
  | 'show-shortcuts'
  | 'check-updates'
  | 'show-about'
  | 'undo'
  | 'redo'
  | 'find';

export interface DesktopPreferences {
  theme?: 'light' | 'dark' | 'system';
  mode?: 'simple' | 'developer';
  recentConnectionIds?: string[];
  sidebarWidth?: number;
}

export interface DesktopConfig {
  isDesktop: true;
  desktopToken: string;
  apiBaseUrl: string;
  platform: string;
  appVersion: string;
  userDataDir: string;
  logFilePath: string;
  systemDark: boolean;
  dpapiProtected: boolean;
}

export interface DesktopImportFileResult {
  canceled: boolean;
  fileName?: string;
  ext?: 'csv' | 'xlsx';
  base64?: string;
  textContent?: string;
}

export interface DesktopSaveFileResult {
  canceled: boolean;
  filePath?: string;
}

export interface DesktopMenuStatePayload {
  hasConnections: boolean;
  hasActiveConnection: boolean;
  hasTables: boolean;
  canModifySchema: boolean;
  canModifyData: boolean;
  hasCriticalOperationRunning: boolean;
  mode: 'simple' | 'developer';
  darkMode: boolean;
}

const api = {
  getConfig: (): Promise<DesktopConfig> => ipcRenderer.invoke('desktop:get-config'),

  openImportFile: (): Promise<DesktopImportFileResult> =>
    ipcRenderer.invoke('desktop:open-import-file'),

  saveExportFile: (opts: {
    defaultName: string;
    content: string;
    encoding?: 'utf8' | 'base64';
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<DesktopSaveFileResult> => ipcRenderer.invoke('desktop:save-export-file', opts),

  confirmDestructiveAction: (opts: {
    title: string;
    message: string;
    detail?: string;
  }): Promise<boolean> => ipcRenderer.invoke('desktop:confirm-dialog', opts),

  showNotification: (opts: { title: string; body: string }): Promise<void> =>
    ipcRenderer.invoke('desktop:show-notification', opts),

  getPreferences: (): Promise<DesktopPreferences> => ipcRenderer.invoke('desktop:get-preferences'),

  savePreferences: (prefs: Partial<DesktopPreferences>): Promise<DesktopPreferences> =>
    ipcRenderer.invoke('desktop:save-preferences', prefs),

  openLogsFolder: (): Promise<boolean> => ipcRenderer.invoke('desktop:open-logs-folder'),

  readRecentLogs: (): Promise<string[]> => ipcRenderer.invoke('desktop:read-recent-logs'),

  checkForUpdates: (): Promise<{
    enabled: boolean;
    configured: boolean;
    channel: string;
    currentVersion: string;
    available: boolean;
    message: string;
    checkedAt: string;
  }> => ipcRenderer.invoke('desktop:check-updates'),

  wipeLocalData: (): Promise<{ wiped: boolean }> => ipcRenderer.invoke('desktop:wipe-local-data'),

  updateMenuState: (state: DesktopMenuStatePayload): Promise<void> =>
    ipcRenderer.invoke('desktop:update-menu-state', state),

  onMenuCommand: (callback: (command: DesktopMenuCommand) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: DesktopMenuCommand) => {
      callback(command);
    };
    ipcRenderer.on('desktop:command', listener);
    return () => {
      ipcRenderer.removeListener('desktop:command', listener);
    };
  },
};

contextBridge.exposeInMainWorld('vdsDesktop', api);
