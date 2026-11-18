import React, { useEffect, useState } from 'react';
import {
  Activity,
  ChevronRight,
  Code2,
  Command,
  CreditCard,
  Database,
  FileCode2,
  GitBranch,
  History,
  LayoutDashboard,
  Lock,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Search,
  Sparkles,
  Sun,
  Table2,
  TableProperties,
  Unlock,
  X,
} from 'lucide-react';
import {
  AppMode,
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
  workspace: WorkspaceSummary | null;
  workspacesList: Array<{ id: string; organizationName: string; name: string }>;
  onSwitchWorkspace: (workspaceId: string) => void;
  onSwitchActor: (actorId: string) => void;
  connections: ConnectionProfile[];
  activeConnection: ConnectionProfile | null;
  onSelectConnection: (connectionId: string) => void;
  snapshot: SchemaSnapshot | null;
  pendingPlansCount: number;
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

export function AppShell({
  activeNav,
  onSelectNav,
  mode,
  onToggleMode,
  darkMode,
  onToggleDark,
  workspace,
  workspacesList,
  onSwitchWorkspace,
  onSwitchActor,
  connections,
  activeConnection,
  onSelectConnection,
  snapshot,
  pendingPlansCount,
  toasts,
  onDismissToast,
  children,
}: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#F7F8FC] text-[#1B2340] dark:bg-[#0B0F1E] dark:text-[#EEF2FF]">
      {/* Mobile Sidebar Backdrop */}
      {mobileMenuOpen && (
        <button
          type="button"
          aria-label="Close navigation drawer"
          onClick={() => setMobileMenuOpen(false)}
          className="fixed inset-0 z-40 bg-slate-950/50 lg:hidden"
        />
      )}

      {/* Left Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex flex-col bg-[#13172B] text-slate-200 border-r border-slate-800/80 transition-all duration-200 lg:static ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        } ${sidebarCollapsed ? 'w-16' : 'w-64'}`}
      >
        {/* Brand Header */}
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

        {/* Navigation Links */}
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

        {/* Bottom Tenant / Workspace Switcher */}
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
          </div>
        )}
      </aside>

      {/* Main Column */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Top Bar */}
        <header className="h-14 shrink-0 flex items-center justify-between gap-4 px-4 lg:px-6 bg-white dark:bg-[#12172B] border-b border-[#E2E6F0] dark:border-[#232B45]">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <button
              type="button"
              aria-label="Open navigation menu"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            >
              <Menu className="h-5 w-5" />
            </button>

            <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm shrink-0">
              <span className="hidden 2xl:inline font-medium text-slate-500 dark:text-slate-400 truncate max-w-[130px]">
                {workspace?.name ?? 'Workspace'}
              </span>
              <ChevronRight className="hidden 2xl:inline h-3.5 w-3.5 text-slate-400 shrink-0" />
              <span className="font-display font-semibold text-[#1B2340] dark:text-white whitespace-nowrap">
                {currentLabel}
              </span>
            </nav>

            {/* Connection Context Selector */}
            {connections.length > 0 && (
              <div className="hidden md:flex items-center gap-2 ml-1 pl-3 border-l border-[#E2E6F0] dark:border-[#232B45] min-w-0">
                <select
                  aria-label="Active database connection"
                  value={activeConnection?.id ?? ''}
                  onChange={(e) => onSelectConnection(e.target.value)}
                  className="max-w-[190px] xl:max-w-[230px] truncate rounded-md bg-[#F7F8FC] dark:bg-[#181F38] border border-[#E2E6F0] dark:border-[#232B45] px-2.5 py-1 text-xs font-medium text-[#1B2340] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
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
                    <span className="hidden 2xl:inline-flex items-center gap-1">
                      <Activity className="h-3 w-3 text-[#16A66A]" />
                      <span>{activeConnection.status === 'connected' ? 'Healthy' : activeConnection.status}</span>
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right Controls */}
          <div className="flex items-center gap-2.5 shrink-0">
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

            {/* Simple / Developer Mode Toggle */}
            <div
              role="group"
              aria-label="Experience mode"
              className="flex items-center p-0.5 rounded-lg bg-[#F1F3F9] dark:bg-[#181F38] border border-[#E2E6F0] dark:border-[#232B45]"
            >
              <button
                type="button"
                onClick={() => onToggleMode('simple')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
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
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  mode === 'developer'
                    ? 'bg-white dark:bg-[#12172B] text-[#6D4AFF] dark:text-[#9D84FF] shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-[#1B2340] dark:hover:text-white'
                }`}
              >
                Developer
              </button>
            </div>

            {/* Active Actor / Role Selector */}
            {workspace && (
              <select
                aria-label="Active workspace member"
                value={workspace.currentActor.id}
                onChange={(e) => onSwitchActor(e.target.value)}
                className="hidden xl:block rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#181F38] px-2.5 py-1.5 text-xs font-medium text-[#1B2340] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
              >
                {workspace.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.role})
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              aria-label={darkMode ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={onToggleDark}
              className="p-2 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </header>

        {/* Main Viewport */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">{children}</main>
      </div>

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
