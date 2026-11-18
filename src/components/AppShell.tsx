import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ChevronRight,
  Code2,
  Command,
  CreditCard,
  Database,
  FileCode2,
  FileText,
  FolderOpen,
  GitBranch,
  History,
  Info,
  Keyboard,
  LayoutDashboard,
  Lock,
  LogIn,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Table2,
  TableProperties,
  Trash2,
  Unlock,
  UserCheck,
  X,
} from 'lucide-react';
import type { DesktopConfig } from '../lib/desktopBridge';
import {
  AppMode,
  AuthSessionInfo,
  ConnectionProfile,
  SchemaSnapshot,
  WorkspaceSummary,
} from '../shared/types';

export type NavSection =
  | 'overview'
  | 'connections'
  | 'explorer'
  | 'designer'
  | 'table-builder'
  | 'records'
  | 'query-builder'
  | 'sql-editor'
  | 'changes'
  | 'ai-assistant'
  | 'audit'
  | 'settings';

export interface ToastMessage {
  id: string;
  tone: 'success' | 'error' | 'info';
  title: string;
  detail?: string;
}

interface AppShellProps {
  activeNav: NavSection;
  onSelectNav: (nav: NavSection) => void;
  mode: AppMode;
  onToggleMode: (mode: AppMode) => void;
  darkMode: boolean;
  onToggleDark: () => void;
  authSession: AuthSessionInfo | null;
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (input: { name: string; email: string; password: string; organizationName?: string }) => Promise<void>;
  onLogout: () => Promise<void>;
  onAcceptInvitation: (token: string, password: string) => Promise<void>;
  workspace: WorkspaceSummary | null;
  workspacesList: Array<{ id: string; organizationName: string; name: string }>;
  onSwitchWorkspace: (workspaceId: string) => void;
  onSwitchActor: (actorId: string) => void;
  connections: ConnectionProfile[];
  activeConnection: ConnectionProfile | null;
  onSelectConnection: (connectionId: string) => void;
  snapshot: SchemaSnapshot | null;
  pendingPlansCount: number;
  sidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
  desktopConfig?: DesktopConfig | null;
  shortcutsModalOpen?: boolean;
  onOpenShortcuts?: () => void;
  onCloseShortcuts?: () => void;
  aboutModalOpen?: boolean;
  aboutTab?: 'about' | 'logs' | 'updates';
  onAboutTabChange?: (tab: 'about' | 'logs' | 'updates') => void;
  onOpenAbout?: (tab?: 'about' | 'logs' | 'updates') => void;
  onCloseAbout?: () => void;
  desktopLogs?: string[];
  onRefreshLogs?: () => void;
  onOpenLogsFolder?: () => void;
  updateReport?: {
    enabled: boolean;
    configured: boolean;
    channel: string;
    currentVersion: string;
    available: boolean;
    message: string;
    checkedAt: string;
  } | null;
  checkingUpdates?: boolean;
  onCheckUpdates?: () => void;
  onWipeLocalData?: () => void;
  toasts: ToastMessage[];
  onDismissToast: (id: string) => void;
  children: React.ReactNode;
}

interface NavItem {
  id: NavSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
}

const SIDEBAR_SNAP_WIDTHS = [224, 256, 288, 320, 352] as const;
const SIDEBAR_WIDTH_CLASSES: Record<number, string> = {
  224: 'lg:w-[224px]',
  256: 'lg:w-[256px]',
  288: 'lg:w-[288px]',
  320: 'lg:w-[320px]',
  352: 'lg:w-[352px]',
};

function snapSidebarWidth(width?: number): number {
  const target = width ?? 256;
  return SIDEBAR_SNAP_WIDTHS.reduce((best, curr) =>
    Math.abs(curr - target) < Math.abs(best - target) ? curr : best
  );
}

export function AppShell({
  activeNav,
  onSelectNav,
  mode,
  onToggleMode,
  darkMode,
  onToggleDark,
  authSession,
  onLogin,
  onRegister,
  onLogout,
  onAcceptInvitation,
  workspace,
  workspacesList,
  onSwitchWorkspace,
  onSwitchActor,
  connections,
  activeConnection,
  onSelectConnection,
  snapshot,
  pendingPlansCount,
  sidebarWidth,
  onSidebarWidthChange,
  desktopConfig,
  shortcutsModalOpen,
  onOpenShortcuts,
  onCloseShortcuts,
  aboutModalOpen,
  aboutTab = 'about',
  onAboutTabChange,
  onOpenAbout,
  onCloseAbout,
  desktopLogs = [],
  onRefreshLogs,
  onOpenLogsFolder,
  updateReport,
  checkingUpdates,
  onCheckUpdates,
  onWipeLocalData,
  toasts,
  onDismissToast,
  children,
}: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [internalShortcutsOpen, setInternalShortcutsOpen] = useState(false);
  const [internalAboutOpen, setInternalAboutOpen] = useState(false);
  const [internalAboutTab, setInternalAboutTab] = useState<'about' | 'logs' | 'updates'>('about');

  // Auth modal state
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authTab, setAuthTab] = useState<'login' | 'register' | 'invite'>('login');
  const [authName, setAuthName] = useState('');
  const [authOrg, setAuthOrg] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const effectiveShortcutsOpen = shortcutsModalOpen ?? internalShortcutsOpen;
  const effectiveAboutOpen = aboutModalOpen ?? internalAboutOpen;
  const effectiveAboutTab = aboutModalOpen !== undefined ? aboutTab : internalAboutTab;

  const openShortcuts = () => {
    if (onOpenShortcuts) onOpenShortcuts();
    else setInternalShortcutsOpen(true);
  };
  const closeShortcuts = () => {
    if (onCloseShortcuts) onCloseShortcuts();
    else setInternalShortcutsOpen(false);
  };
  const openAbout = (tab: 'about' | 'logs' | 'updates' = 'about') => {
    if (onOpenAbout) onOpenAbout(tab);
    else {
      setInternalAboutTab(tab);
      setInternalAboutOpen(true);
    }
  };
  const closeAbout = () => {
    if (onCloseAbout) onCloseAbout();
    else setInternalAboutOpen(false);
  };
  const changeAboutTab = (tab: 'about' | 'logs' | 'updates') => {
    if (onAboutTabChange) onAboutTabChange(tab);
    else setInternalAboutTab(tab);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        if (effectiveShortcutsOpen) closeShortcuts();
        else openShortcuts();
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false);
        setAuthModalOpen(false);
        closeShortcuts();
        closeAbout();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [effectiveShortcutsOpen]);

  const handleSidebarResizeMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (sidebarCollapsed || !onSidebarWidthChange) return;
    e.preventDefault();
    const startX = e.clientX;
    const baseWidth = snapSidebarWidth(sidebarWidth);
    const onMouseMove = (moveEvent: MouseEvent) => {
      const next = snapSidebarWidth(baseWidth + (moveEvent.clientX - startX));
      onSidebarWidthChange(next);
    };
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const snappedSidebarWidth = snapSidebarWidth(sidebarWidth);
  const sidebarWidthClass = sidebarCollapsed ? 'w-16' : `w-64 ${SIDEBAR_WIDTH_CLASSES[snappedSidebarWidth]}`;

  const navGroups: Array<{ title: string; items: NavItem[] }> = [
    {
      title: 'Workspace',
      items: [
        { id: 'overview', label: 'Overview', icon: LayoutDashboard },
        { id: 'connections', label: 'Connections', icon: Plug },
      ],
    },
    {
      title: mode === 'simple' ? 'Database Studio' : 'Schema & Data',
      items: [
        { id: 'explorer', label: mode === 'simple' ? 'Database Explorer' : 'Object Explorer', icon: Database },
        { id: 'designer', label: 'Visual Designer', icon: GitBranch },
        { id: 'table-builder', label: mode === 'simple' ? 'Table Builder' : 'DDL Designer', icon: TableProperties },
        { id: 'records', label: 'Records', icon: Table2 },
      ],
    },
    {
      title: 'Queries & Changes',
      items: [
        { id: 'query-builder', label: 'Query Builder', icon: Search },
        { id: 'sql-editor', label: 'SQL Editor', icon: Code2 },
        { id: 'changes', label: 'Change Center', icon: FileCode2, badge: pendingPlansCount || undefined },
        { id: 'ai-assistant', label: 'AI Assistant', icon: Sparkles },
      ],
    },
    {
      title: 'Governance',
      items: [
        { id: 'audit', label: 'Audit & History', icon: History },
        { id: 'settings', label: 'Team & Billing', icon: CreditCard },
      ],
    },
  ];

  const allNavItems = navGroups.flatMap((g) => g.items);
  const currentLabel = allNavItems.find((n) => n.id === activeNav)?.label ?? 'Overview';

  const paletteMatches = allNavItems.filter((item) =>
    item.label.toLowerCase().includes(paletteQuery.trim().toLowerCase())
  );

  const tableMatches = (snapshot?.tables ?? []).filter((t) =>
    t.fullName.toLowerCase().includes(paletteQuery.trim().toLowerCase())
  );

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      if (authTab === 'login') {
        await onLogin(authEmail, authPassword);
      } else if (authTab === 'register') {
        await onRegister({
          name: authName,
          email: authEmail,
          password: authPassword,
          organizationName: authOrg || undefined,
        });
      } else {
        await onAcceptInvitation(inviteToken, authPassword);
      }
      setAuthPassword('');
      setAuthModalOpen(false);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setAuthBusy(false);
    }
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#F7F8FC] text-[#1B2340] dark:bg-[#0B0F1E] dark:text-[#EEF2FF]">
      {mobileMenuOpen && (
        <button
          type="button"
          aria-label="Close navigation drawer"
          onClick={() => setMobileMenuOpen(false)}
          className="fixed inset-0 z-40 bg-slate-950/50 lg:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex flex-col bg-[#13172B] text-slate-200 border-r border-slate-800/80 transition-all duration-200 lg:relative lg:static ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        } ${sidebarWidthClass}`}
      >
        <div className="flex h-14 items-center justify-between px-3.5 border-b border-white/10 shrink-0">
          {!sidebarCollapsed && (
            <button
              type="button"
              onClick={() => onSelectNav('overview')}
              className="flex items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6D4AFF] rounded-md"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[#6D4AFF] text-white font-display text-xs font-bold shrink-0">
                V
              </span>
              <span className="font-display text-sm font-semibold tracking-tight text-white whitespace-nowrap">
                Visual Database Studio
              </span>
            </button>
          )}
          {sidebarCollapsed && (
            <button
              type="button"
              aria-label="Visual Database Studio Home"
              onClick={() => onSelectNav('overview')}
              className="mx-auto flex h-7 w-7 items-center justify-center rounded-md bg-[#6D4AFF] text-white font-display text-xs font-bold"
            >
              V
            </button>
          )}
          <button
            type="button"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setSidebarCollapsed((c) => !c)}
            className="hidden lg:flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
          >
            {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        </div>

        <nav aria-label="Primary navigation" className="flex-1 overflow-y-auto px-2.5 py-3 space-y-5">
          {navGroups.map((group) => (
            <div key={group.title}>
              {!sidebarCollapsed && (
                <div className="px-2.5 pb-1.5 text-[11px] font-medium tracking-wide text-slate-400">
                  {group.title}
                </div>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeNav === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        onSelectNav(item.id);
                        setMobileMenuOpen(false);
                      }}
                      title={sidebarCollapsed ? item.label : undefined}
                      aria-current={isActive ? 'page' : undefined}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                        isActive
                          ? 'bg-[#6D4AFF] text-white'
                          : 'text-slate-300 hover:bg-white/8 hover:text-white'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {!sidebarCollapsed && <span className="truncate flex-1 text-left">{item.label}</span>}
                      {!sidebarCollapsed && item.badge ? (
                        <span className="ml-auto font-mono text-[11px] tabular-nums bg-white/15 px-1.5 py-0.5 rounded text-white">
                          {item.badge}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {!sidebarCollapsed && workspace && (
          <div className="p-3 border-t border-white/10 space-y-2 shrink-0">
            <label htmlFor="ws-select" className="block text-[11px] text-slate-400">
              Active Workspace
            </label>
            <select
              id="ws-select"
              value={workspace.id}
              onChange={(e) => onSwitchWorkspace(e.target.value)}
              className="w-full rounded-md bg-white/8 border border-white/10 px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
            >
              {workspacesList.map((ws) => (
                <option key={ws.id} value={ws.id} className="bg-[#13172B] text-white">
                  {ws.organizationName} · {ws.name}
                </option>
              ))}
            </select>
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>{workspace.subscription.name}</span>
              <span className="tabular-nums">
                {workspace.subscription.connectionsUsed}/{workspace.subscription.connectionsLimit} DBs
              </span>
            </div>
            <div className="flex items-center justify-between pt-1 border-t border-white/10 text-[11px] text-slate-400">
              <button
                type="button"
                onClick={() => openAbout('about')}
                className="inline-flex items-center gap-1 hover:text-white transition-colors"
              >
                <Info className="h-3 w-3" />
                <span>{desktopConfig?.isDesktop ? `Desktop v${desktopConfig.appVersion}` : 'Edition Info'}</span>
              </button>
              <button
                type="button"
                onClick={openShortcuts}
                className="inline-flex items-center gap-1 hover:text-white transition-colors"
              >
                <Keyboard className="h-3 w-3" />
                <span>Shortcuts</span>
              </button>
            </div>
          </div>
        )}
        {!sidebarCollapsed && onSidebarWidthChange && (
          <button
            type="button"
            aria-label="Resize navigation sidebar"
            onMouseDown={handleSidebarResizeMouseDown}
            onClick={() => {
              const idx = SIDEBAR_SNAP_WIDTHS.indexOf(snappedSidebarWidth as (typeof SIDEBAR_SNAP_WIDTHS)[number]);
              const next = SIDEBAR_SNAP_WIDTHS[(idx + 1) % SIDEBAR_SNAP_WIDTHS.length];
              onSidebarWidthChange(next);
            }}
            title="Drag or click to adjust sidebar width"
            className="hidden lg:block absolute inset-y-0 -right-1 w-2 cursor-col-resize hover:bg-[#6D4AFF]/40 transition-colors"
          />
        )}
      </aside>

      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        <header className="h-14 shrink-0 flex items-center justify-between gap-2 sm:gap-4 px-3 sm:px-4 lg:px-6 bg-white dark:bg-[#12172B] border-b border-[#E2E6F0] dark:border-[#232B45]">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              type="button"
              aria-label="Open navigation menu"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            >
              <Menu className="h-5 w-5" />
            </button>

            <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm min-w-0">
              <span className="hidden 2xl:inline font-medium text-slate-500 dark:text-slate-400 truncate max-w-[130px]">
                {workspace?.name ?? 'Workspace'}
              </span>
              <ChevronRight className="hidden 2xl:inline h-3.5 w-3.5 text-slate-400 shrink-0" />
              <span className="font-display font-semibold text-[#1B2340] dark:text-white truncate">
                {currentLabel}
              </span>
            </nav>

            {connections.length > 0 && (
              <div className="hidden md:flex items-center gap-2 ml-1 pl-3 border-l border-[#E2E6F0] dark:border-[#232B45] min-w-0">
                <select
                  aria-label="Active database connection"
                  value={activeConnection?.id ?? ''}
                  onChange={(e) => onSelectConnection(e.target.value)}
                  className="max-w-[180px] xl:max-w-[220px] truncate rounded-md bg-[#F7F8FC] dark:bg-[#181F38] border border-[#E2E6F0] dark:border-[#232B45] px-2.5 py-1 text-xs font-medium text-[#1B2340] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
                >
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {activeConnection && (
                  <div className="hidden xl:flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
                    <span className="capitalize font-medium text-[#1B2340] dark:text-slate-200">
                      {activeConnection.environment}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1">
                      {activeConnection.readOnly ? (
                        <>
                          <Lock className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                          <span>Read-Only</span>
                        </>
                      ) : (
                        <>
                          <Unlock className="h-3 w-3 text-[#16A66A]" />
                          <span>Read-Write</span>
                        </>
                      )}
                    </span>
                    <span className="hidden 2xl:inline" aria-hidden="true">·</span>
                    <span
                      className={`hidden 2xl:inline-flex items-center gap-1 ${
                        activeConnection.status === 'connected'
                          ? 'text-[#16A66A]'
                          : 'text-[#E5484D]'
                      }`}
                    >
                      <Activity className="h-3 w-3" />
                      <span>
                        {activeConnection.status === 'connected'
                          ? 'Connected'
                          : activeConnection.status === 'error'
                          ? 'Error'
                          : 'Disconnected'}
                      </span>
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              className="hidden sm:flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] text-xs text-slate-500 dark:text-slate-400 hover:text-[#1B2340] dark:hover:text-white transition-colors whitespace-nowrap"
            >
              <Command className="h-3.5 w-3.5" />
              <span>Quick jump</span>
              <kbd className="font-mono text-[10px] px-1 py-0.5 rounded bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45]">
                ⌘K
              </kbd>
            </button>

            <div
              role="group"
              aria-label="Experience mode"
              className="flex items-center p-0.5 rounded-lg bg-[#F1F3F9] dark:bg-[#181F38] border border-[#E2E6F0] dark:border-[#232B45]"
            >
              <button
                type="button"
                onClick={() => onToggleMode('simple')}
                className={`px-2 py-1 sm:px-2.5 text-[11px] sm:text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  mode === 'simple'
                    ? 'bg-white dark:bg-[#12172B] text-[#1B2340] dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-[#1B2340] dark:hover:text-white'
                }`}
              >
                Simple
              </button>
              <button
                type="button"
                onClick={() => onToggleMode('developer')}
                className={`px-2 py-1 sm:px-2.5 text-[11px] sm:text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  mode === 'developer'
                    ? 'bg-white dark:bg-[#12172B] text-[#6D4AFF] dark:text-[#9D84FF] shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-[#1B2340] dark:hover:text-white'
                }`}
              >
                Developer
              </button>
            </div>

            {workspace && !authSession?.authenticated && (
              <select
                aria-label="Active workspace member"
                value={workspace.currentActor.id}
                onChange={(e) => onSwitchActor(e.target.value)}
                className="hidden xl:block max-w-[175px] truncate rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#181F38] px-2.5 py-1.5 text-xs font-medium text-[#1B2340] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
              >
                {workspace.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.role})
                  </option>
                ))}
              </select>
            )}

            {authSession?.authenticated && authSession.user ? (
              <div className="flex items-center gap-1.5">
                <span className="hidden md:inline-flex items-center gap-1 text-xs font-medium text-[#1B2340] dark:text-slate-200 whitespace-nowrap">
                  <UserCheck className="h-3.5 w-3.5 text-[#16A66A]" />
                  <span>{authSession.user.name}</span>
                </span>
                <button
                  type="button"
                  onClick={onLogout}
                  aria-label="Sign out"
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Sign Out</span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                aria-label="Sign In"
                onClick={() => {
                  setAuthError(null);
                  setAuthModalOpen(true);
                }}
                className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] text-xs font-medium text-[#1B2340] dark:text-white hover:border-[#6D4AFF] whitespace-nowrap"
              >
                <LogIn className="h-3.5 w-3.5 text-[#6D4AFF]" />
                <span className="hidden sm:inline">Sign In</span>
              </button>
            )}

            <button
              type="button"
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (Ctrl+/)"
              onClick={openShortcuts}
              className="hidden md:flex p-2 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
            >
              <Keyboard className="h-4 w-4" />
            </button>

            <button
              type="button"
              aria-label={darkMode ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={onToggleDark}
              className="p-2 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
            >
              {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </header>

        {/* Honest Disconnected Warning Strip when an active connection failed or is disconnected */}
        {activeConnection && (activeConnection.status === 'disconnected' || activeConnection.status === 'error') && (
          <div className="px-4 lg:px-6 py-2 bg-red-50 dark:bg-red-950/40 border-b border-red-200 dark:border-red-900 flex flex-wrap items-center justify-between gap-2 text-xs text-red-800 dark:text-red-200">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle className="h-4 w-4 shrink-0 text-[#E5484D]" />
              <span className="truncate">
                <strong>{activeConnection.name}</strong> is {activeConnection.status}
                {activeConnection.lastError ? ` — ${activeConnection.lastError}` : '. Cached snapshot shown if available.'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onSelectNav('connections')}
              className="font-medium underline shrink-0"
            >
              Open Diagnostics
            </button>
          </div>
        )}

        <main className="flex-1 overflow-y-auto p-4 lg:p-6">{children}</main>
      </div>

      {/* Authentication / Account Modal */}
      {authModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Account sign in"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/55"
        >
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-base font-bold text-[#1B2340] dark:text-white">
                Workspace Account
              </h2>
              <button
                type="button"
                aria-label="Close sign in dialog"
                onClick={() => setAuthModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center gap-1 p-1 rounded-lg bg-[#F1F3F9] dark:bg-[#181F38]">
              {(
                [
                  { id: 'login', label: 'Sign In' },
                  { id: 'register', label: 'Create Account' },
                  { id: 'invite', label: 'Accept Invite' },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setAuthTab(t.id);
                    setAuthError(null);
                  }}
                  className={`flex-1 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
                    authTab === t.id
                      ? 'bg-white dark:bg-[#12172B] text-[#6D4AFF] shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <form onSubmit={handleAuthSubmit} className="space-y-3">
              {authTab === 'register' && (
                <>
                  <div>
                    <label htmlFor="auth-name" className="block text-xs font-medium mb-1">
                      Full Name
                    </label>
                    <input
                      id="auth-name"
                      type="text"
                      required
                      value={authName}
                      onChange={(e) => setAuthName(e.target.value)}
                      placeholder="Alex Mercer"
                      className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-xs"
                    />
                  </div>
                  <div>
                    <label htmlFor="auth-org" className="block text-xs font-medium mb-1">
                      Organization Name
                    </label>
                    <input
                      id="auth-org"
                      type="text"
                      value={authOrg}
                      onChange={(e) => setAuthOrg(e.target.value)}
                      placeholder="Acme Data Group"
                      className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-xs"
                    />
                  </div>
                </>
              )}

              {authTab === 'invite' && (
                <div>
                  <label htmlFor="auth-invite-token" className="block text-xs font-medium mb-1">
                    Invitation Token
                  </label>
                  <input
                    id="auth-invite-token"
                    type="text"
                    required
                    value={inviteToken}
                    onChange={(e) => setInviteToken(e.target.value)}
                    placeholder="Paste token from workspace owner"
                    className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-xs font-mono"
                  />
                </div>
              )}

              {authTab !== 'invite' && (
                <div>
                  <label htmlFor="auth-email" className="block text-xs font-medium mb-1">
                    Email Address
                  </label>
                  <input
                    id="auth-email"
                    type="email"
                    required
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="aisha@northwind.example"
                    className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-xs"
                  />
                </div>
              )}

              <div>
                <label htmlFor="auth-password" className="block text-xs font-medium mb-1">
                  Password
                </label>
                <input
                  id="auth-password"
                  type="password"
                  required
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-xs"
                />
              </div>

              {authTab === 'login' && (
                <div className="rounded-lg bg-[#F7F8FC] dark:bg-[#181F38] border border-[#E2E6F0] dark:border-[#232B45] p-2.5 text-[11px] text-slate-600 dark:text-slate-300">
                  Localhost seeded account: <span className="font-mono">aisha@northwind.example</span> /{' '}
                  <span className="font-mono">VisualDB#2026</span>
                </div>
              )}

              {authError && (
                <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-2.5 text-xs text-[#E5484D]">
                  {authError}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setAuthModalOpen(false)}
                  className="px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={authBusy}
                  className="px-4 py-1.5 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-xs font-medium disabled:opacity-50"
                >
                  {authBusy
                    ? 'Processing...'
                    : authTab === 'login'
                    ? 'Sign In'
                    : authTab === 'register'
                    ? 'Create Workspace'
                    : 'Join Workspace'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Command Palette Modal */}
      {paletteOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4 bg-slate-950/50"
        >
          <div className="w-full max-w-lg rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] shadow-2xl overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[#E2E6F0] dark:border-[#232B45]">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                autoFocus
                type="text"
                value={paletteQuery}
                onChange={(e) => setPaletteQuery(e.target.value)}
                placeholder="Jump to screen or table..."
                className="flex-1 bg-transparent text-sm text-[#1B2340] dark:text-white placeholder:text-slate-400 focus:outline-none"
              />
              <button
                type="button"
                aria-label="Close command palette"
                onClick={() => setPaletteOpen(false)}
                className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-80 overflow-y-auto p-2 space-y-3">
              <div>
                <div className="px-2 py-1 text-[11px] font-medium text-slate-400">Screens</div>
                {paletteMatches.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        onSelectNav(item.id);
                        setPaletteOpen(false);
                        setPaletteQuery('');
                      }}
                      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-[#1B2340] dark:text-slate-200 hover:bg-[#F1F3F9] dark:hover:bg-[#181F38]"
                    >
                      <Icon className="h-4 w-4 text-[#6D4AFF]" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
              {tableMatches.length > 0 && (
                <div>
                  <div className="px-2 py-1 text-[11px] font-medium text-slate-400">
                    Tables in {snapshot?.databaseName}
                  </div>
                  {tableMatches.slice(0, 8).map((tbl) => (
                    <button
                      key={tbl.fullName}
                      type="button"
                      onClick={() => {
                        onSelectNav('records');
                        setPaletteOpen(false);
                        setPaletteQuery('');
                      }}
                      className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-sm text-[#1B2340] dark:text-slate-200 hover:bg-[#F1F3F9] dark:hover:bg-[#181F38]"
                    >
                      <span className="font-mono text-xs">{tbl.fullName}</span>
                      <span className="text-xs text-slate-400 tabular-nums">
                        {tbl.columns.length} cols
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Keyboard Shortcuts Modal */}
      {effectiveShortcutsOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/55"
        >
          <div className="w-full max-w-lg rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Keyboard className="h-4 w-4 text-[#6D4AFF]" />
                <h2 className="font-display text-base font-bold text-[#1B2340] dark:text-white">
                  Keyboard Shortcuts
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close keyboard shortcuts"
                onClick={closeShortcuts}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="divide-y divide-[#E2E6F0] dark:divide-[#232B45] text-xs">
              {[
                { keys: 'Ctrl + K', desc: 'Open Quick Jump & Table Palette' },
                { keys: 'Ctrl + /', desc: 'Open Keyboard Shortcuts Reference' },
                { keys: 'Ctrl + N', desc: 'New SQL Server Connection Wizard (Desktop)' },
                { keys: 'Ctrl + O', desc: 'Open Connection Manager (Desktop)' },
                { keys: 'Ctrl + Shift + D', desc: 'Detect Local SQL Server Instances (Desktop)' },
                { keys: 'Ctrl + T', desc: 'Open Table Builder / DDL Designer (Desktop)' },
                { keys: 'Ctrl + Shift + Q', desc: 'Open SQL Editor & Query Workspace (Desktop)' },
                { keys: 'F5', desc: 'Refresh Active Database Schema (Desktop)' },
                { keys: 'Esc', desc: 'Close Active Modal Dialog' },
              ].map((row) => (
                <div key={row.keys} className="flex items-center justify-between py-2 gap-3">
                  <span className="text-slate-600 dark:text-slate-300">{row.desc}</span>
                  <kbd className="font-mono text-[11px] px-2 py-0.5 rounded border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] text-[#1B2340] dark:text-slate-200 whitespace-nowrap">
                    {row.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Edition, Diagnostics, Logs & Updates Modal */}
      {effectiveAboutOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Visual Database Studio Diagnostics and About"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/55"
        >
          <div className="w-full max-w-2xl rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-[#6D4AFF]" />
                <h2 className="font-display text-base font-bold text-[#1B2340] dark:text-white">
                  Visual Database Studio · {desktopConfig?.isDesktop ? 'Desktop Edition' : 'Web Edition'}
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close diagnostics modal"
                onClick={closeAbout}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {desktopConfig?.isDesktop && (
              <div className="flex items-center gap-1 p-1 rounded-lg bg-[#F1F3F9] dark:bg-[#181F38]">
                {(
                  [
                    { id: 'about', label: 'Overview & Security' },
                    { id: 'logs', label: 'Application Logs' },
                    { id: 'updates', label: 'Updates' },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => changeAboutTab(t.id)}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
                      effectiveAboutTab === t.id
                        ? 'bg-white dark:bg-[#12172B] text-[#6D4AFF] shadow-xs'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}

            {effectiveAboutTab === 'about' && (
              <div className="space-y-3 text-xs">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] p-3">
                    <div className="text-[11px] text-slate-500">Runtime Edition</div>
                    <div className="font-semibold mt-0.5">
                      {desktopConfig?.isDesktop ? `Desktop (${desktopConfig.platform})` : 'Localhost / Cloud Web'}
                    </div>
                  </div>
                  <div className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] p-3">
                    <div className="text-[11px] text-slate-500">Version</div>
                    <div className="font-mono font-semibold mt-0.5 tabular-nums">
                      v{desktopConfig?.appVersion || '1.0.0'}
                    </div>
                  </div>
                </div>

                {desktopConfig?.isDesktop ? (
                  <>
                    <div className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] p-3 space-y-1.5">
                      <div className="font-medium text-[#1B2340] dark:text-white">
                        Local Security & Storage
                      </div>
                      <div className="text-slate-600 dark:text-slate-300">
                        Master Key Encryption:{' '}
                        <span className="font-mono">
                          {desktopConfig.dpapiProtected
                            ? 'Windows DPAPI (safeStorage active)'
                            : 'OS-scoped local key fallback'}
                        </span>
                      </div>
                      <div className="text-slate-600 dark:text-slate-300 break-all">
                        User Data Path: <span className="font-mono text-[11px]">{desktopConfig.userDataDir}</span>
                      </div>
                    </div>

                    {onWipeLocalData && (
                      <div className="rounded-lg border border-red-200 dark:border-red-900/80 bg-red-50/60 dark:bg-red-950/20 p-3 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="font-medium text-[#E5484D]">Clear Local Desktop Storage</div>
                          <div className="text-[11px] text-slate-600 dark:text-slate-400">
                            Removes local SQLite metadata, DPAPI encrypted credentials, preferences, and window state.
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={onWipeLocalData}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E5484D] text-[#E5484D] hover:bg-[#E5484D] hover:text-white text-xs font-medium transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span>Delete All Local Data</span>
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] p-3 text-slate-600 dark:text-slate-300">
                    Running in browser Web Edition. For native Windows file dialogs, DPAPI key protection, offline
                    Desktop bundling, and Windows application menus, use the Windows Desktop Installer build.
                  </div>
                )}
              </div>
            )}

            {effectiveAboutTab === 'logs' && desktopConfig?.isDesktop && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-slate-500 font-mono truncate">
                    {desktopConfig.logFilePath}
                  </span>
                  <div className="flex items-center gap-2">
                    {onRefreshLogs && (
                      <button
                        type="button"
                        onClick={onRefreshLogs}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs font-medium"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        <span>Refresh</span>
                      </button>
                    )}
                    {onOpenLogsFolder && (
                      <button
                        type="button"
                        onClick={onOpenLogsFolder}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        <span>Open Logs Folder</span>
                      </button>
                    )}
                  </div>
                </div>
                <pre className="max-h-64 overflow-auto rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#0B0F1E] text-slate-200 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                  {desktopLogs.length > 0 ? desktopLogs.join('\n') : 'No application log lines recorded yet.'}
                </pre>
              </div>
            )}

            {effectiveAboutTab === 'updates' && desktopConfig?.isDesktop && (
              <div className="space-y-3 text-xs">
                <div className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">Automatic Update Channel</span>
                    <span className="font-mono text-[11px] px-2 py-0.5 rounded border border-[#E2E6F0] dark:border-[#232B45]">
                      {updateReport?.enabled ? 'Signed HTTPS Feed Active' : 'Disabled (Verification Required)'}
                    </span>
                  </div>
                  <p className="text-slate-600 dark:text-slate-300">
                    {updateReport?.message || 'Click Check for Updates to query current signed release channel status.'}
                  </p>
                  {updateReport?.checkedAt && (
                    <div className="text-[11px] text-slate-500 font-mono">
                      Last checked: {new Date(updateReport.checkedAt).toLocaleString()}
                    </div>
                  )}
                </div>
                {onCheckUpdates && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      disabled={checkingUpdates}
                      onClick={onCheckUpdates}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-xs font-medium disabled:opacity-50"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      <span>{checkingUpdates ? 'Checking...' : 'Check for Updates'}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Toast Notifications */}
      <div
        aria-live="polite"
        className="fixed top-16 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start justify-between gap-3 rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-3.5 shadow-lg"
          >
            <div className="min-w-0">
              <div
                className={`text-sm font-medium ${
                  t.tone === 'error'
                    ? 'text-[#E5484D]'
                    : t.tone === 'success'
                    ? 'text-[#16A66A]'
                    : 'text-[#1B2340] dark:text-white'
                }`}
              >
                {t.title}
              </div>
              {t.detail && (
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 break-words">
                  {t.detail}
                </p>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => onDismissToast(t.id)}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-white shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
