import type {
  DesktopConfig,
  DesktopImportFileResult,
  DesktopMenuCommand,
  DesktopMenuStatePayload,
  DesktopPreferences,
  DesktopSaveFileResult,
} from '../../electron/preload';

export interface VdsDesktopApi {
  getConfig: () => Promise<DesktopConfig>;
  openImportFile: () => Promise<DesktopImportFileResult>;
  saveExportFile: (opts: {
    defaultName: string;
    content: string;
    encoding?: 'utf8' | 'base64';
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => Promise<DesktopSaveFileResult>;
  confirmDestructiveAction: (opts: {
    title: string;
    message: string;
    detail?: string;
  }) => Promise<boolean>;
  showNotification: (opts: { title: string; body: string }) => Promise<void>;
  getPreferences: () => Promise<DesktopPreferences>;
  savePreferences: (prefs: Partial<DesktopPreferences>) => Promise<DesktopPreferences>;
  openLogsFolder: () => Promise<boolean>;
  readRecentLogs: () => Promise<string[]>;
  checkForUpdates: () => Promise<{
    enabled: boolean;
    configured: boolean;
    channel: string;
    currentVersion: string;
    available: boolean;
    message: string;
    checkedAt: string;
  }>;
  wipeLocalData: () => Promise<{ wiped: boolean }>;
  updateMenuState: (state: DesktopMenuStatePayload) => Promise<void>;
  onMenuCommand: (callback: (command: DesktopMenuCommand) => void) => () => void;
}

declare global {
  interface Window {
    vdsDesktop?: VdsDesktopApi;
  }
}

export type {
  DesktopConfig,
  DesktopImportFileResult,
  DesktopMenuCommand,
  DesktopMenuStatePayload,
  DesktopPreferences,
};

let cachedConfig: DesktopConfig | null = null;

export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && Boolean(window.vdsDesktop);
}

export async function getDesktopConfig(): Promise<DesktopConfig | null> {
  if (typeof window === 'undefined' || !window.vdsDesktop) return null;
  if (cachedConfig) return cachedConfig;
  cachedConfig = await window.vdsDesktop.getConfig();
  return cachedConfig;
}

export async function saveExportWithDesktopFallback(opts: {
  defaultName: string;
  content: string;
  mimeType: string;
  encoding?: 'utf8' | 'base64';
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<{ saved: boolean; canceled?: boolean; filePath?: string }> {
  if (typeof window !== 'undefined' && window.vdsDesktop) {
    const res = await window.vdsDesktop.saveExportFile({
      defaultName: opts.defaultName,
      content: opts.content,
      encoding: opts.encoding ?? 'utf8',
      filters: opts.filters,
    });
    return { saved: !res.canceled, canceled: res.canceled, filePath: res.filePath };
  }

  let blob: Blob;
  if (opts.encoding === 'base64') {
    const bin = atob(opts.content);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      bytes[i] = bin.charCodeAt(i);
    }
    blob = new Blob([bytes], { type: opts.mimeType });
  } else {
    blob = new Blob([opts.content], { type: opts.mimeType });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = opts.defaultName;
  a.click();
  URL.revokeObjectURL(url);
  return { saved: true };
}
