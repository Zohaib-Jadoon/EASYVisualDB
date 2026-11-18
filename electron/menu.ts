import { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import type { DesktopMenuCommand, DesktopMenuStatePayload } from './preload';

export function buildDesktopMenuTemplate(
  state: DesktopMenuStatePayload,
  dispatch: (cmd: DesktopMenuCommand) => void,
  onQuit: () => void
): MenuItemConstructorOptions[] {
  return [
    {
      label: '&File',
      submenu: [
        {
          label: 'New Connection...',
          accelerator: 'CmdOrCtrl+N',
          click: () => dispatch('new-connection'),
        },
        {
          label: 'Open Connection Manager',
          accelerator: 'CmdOrCtrl+O',
          click: () => dispatch('open-connection'),
        },
        { type: 'separator' },
        {
          label: 'Create Database...',
          enabled: state.hasActiveConnection,
          click: () => dispatch('create-database'),
        },
        {
          label: 'Create Table...',
          accelerator: 'CmdOrCtrl+T',
          enabled: state.hasActiveConnection && state.canModifySchema,
          click: () => dispatch('create-table'),
        },
        { type: 'separator' },
        {
          label: 'Import Data (CSV / Excel)...',
          enabled: state.hasActiveConnection && state.hasTables && state.canModifyData,
          click: () => dispatch('import-data'),
        },
        {
          label: 'Export Data...',
          enabled: state.hasActiveConnection && state.hasTables,
          click: () => dispatch('export-data'),
        },
        { type: 'separator' },
        {
          label: 'Exit',
          accelerator: 'Alt+F4',
          click: () => onQuit(),
        },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Quick Jump / Find',
          accelerator: 'CmdOrCtrl+K',
          click: () => dispatch('find'),
        },
      ],
    },
    {
      label: '&Database',
      submenu: [
        {
          label: 'Detect Local SQL Servers',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => dispatch('detect-local'),
        },
        {
          label: 'Connect...',
          click: () => dispatch('open-connection'),
        },
        {
          label: 'Disconnect',
          enabled: state.hasActiveConnection,
          click: () => dispatch('disconnect-active'),
        },
        { type: 'separator' },
        {
          label: 'Refresh Schema',
          accelerator: 'F5',
          enabled: state.hasActiveConnection,
          click: () => dispatch('refresh-schema'),
        },
        {
          label: 'New Query',
          accelerator: 'CmdOrCtrl+Shift+Q',
          enabled: state.hasActiveConnection,
          click: () => dispatch('new-query'),
        },
        {
          label: 'Open Visual Designer',
          enabled: state.hasActiveConnection,
          click: () => dispatch('open-designer'),
        },
      ],
    },
    {
      label: '&View',
      submenu: [
        {
          label: 'Dashboard',
          click: () => dispatch('nav-overview'),
        },
        {
          label: 'Database Explorer',
          click: () => dispatch('nav-explorer'),
        },
        {
          label: 'Visual Designer',
          click: () => dispatch('nav-designer'),
        },
        {
          label: 'SQL Editor',
          click: () => dispatch('nav-sql-editor'),
        },
        { type: 'separator' },
        {
          label: 'Simple Mode',
          type: 'radio',
          checked: state.mode === 'simple',
          click: () => dispatch('mode-simple'),
        },
        {
          label: 'Developer Mode',
          type: 'radio',
          checked: state.mode === 'developer',
          click: () => dispatch('mode-developer'),
        },
        { type: 'separator' },
        {
          label: 'Light Mode',
          type: 'radio',
          checked: !state.darkMode,
          click: () => dispatch('theme-light'),
        },
        {
          label: 'Dark Mode',
          type: 'radio',
          checked: state.darkMode,
          click: () => dispatch('theme-dark'),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Tools',
      submenu: [
        {
          label: 'Connection Manager',
          click: () => dispatch('nav-connections'),
        },
        {
          label: 'Change Center',
          click: () => dispatch('nav-changes'),
        },
        {
          label: 'Audit & Query History',
          click: () => dispatch('nav-audit'),
        },
        {
          label: 'Application Logs',
          click: () => dispatch('show-logs'),
        },
        { type: 'separator' },
        {
          label: 'Preferences & Workspace Policies',
          click: () => dispatch('nav-settings'),
        },
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: () => dispatch('show-shortcuts'),
        },
        {
          label: 'Documentation & Setup Guide',
          click: () => dispatch('show-about'),
        },
        { type: 'separator' },
        {
          label: 'Check for Updates...',
          click: () => dispatch('check-updates'),
        },
        {
          label: 'About Visual Database Studio',
          click: () => dispatch('show-about'),
        },
      ],
    },
  ];
}

export class DesktopMenuManager {
  private currentState: DesktopMenuStatePayload = {
    hasConnections: false,
    hasActiveConnection: false,
    hasTables: false,
    canModifySchema: false,
    canModifyData: false,
    hasCriticalOperationRunning: false,
    mode: 'simple',
    darkMode: false,
  };

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly onQuit: () => void
  ) {}

  install(): void {
    this.rebuild();
  }

  updateState(next: DesktopMenuStatePayload): void {
    this.currentState = next;
    this.rebuild();
  }

  getState(): DesktopMenuStatePayload {
    return this.currentState;
  }

  private dispatch(command: DesktopMenuCommand): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('desktop:command', command);
  }

  private rebuild(): void {
    const template = buildDesktopMenuTemplate(
      this.currentState,
      (cmd) => this.dispatch(cmd),
      this.onQuit
    );
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }
}
