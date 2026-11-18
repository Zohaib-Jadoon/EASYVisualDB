import React, { useCallback, useEffect, useState } from 'react';
import { AiAssistantPage } from './components/AiAssistantPage';
import { AppShell, NavSection, ToastMessage } from './components/AppShell';
import { AuditPage } from './components/AuditPage';
import { ChangeCenterPage } from './components/ChangeCenterPage';
import { ConnectionsPage } from './components/ConnectionsPage';
import { DatabaseExplorerPage } from './components/DatabaseExplorerPage';
import { OverviewPage } from './components/OverviewPage';
import { QueryToolsPage } from './components/QueryToolsPage';
import { RecordsPage } from './components/RecordsPage';
import { TableDesignerPage } from './components/TableDesignerPage';
import { VisualDesignerPage } from './components/VisualDesignerPage';
import { WorkspaceBillingPage } from './components/WorkspaceBillingPage';
import { api, setApiTenantContext } from './lib/api';
import {
  DesktopConfig,
  DesktopMenuCommand,
  getDesktopConfig,
  isDesktopApp,
} from './lib/desktopBridge';
import { canModifyData, canModifySchema } from './shared/permissions';
import {
  AppMode,
  AuditEvent,
  AuthSessionInfo,
  BillingCheckoutSession,
  ChangePlan,
  ConnectionProfile,
  SchemaSnapshot,
  TableSchema,
  WindowsAgentRecord,
  WorkspaceSummary,
} from './shared/types';

export default function App() {
  const [activeNav, setActiveNav] = useState<NavSection>('overview');
  const [mode, setMode] = useState<AppMode>('simple');
  const [darkMode, setDarkMode] = useState(false);

  const [authSession, setAuthSession] = useState<AuthSessionInfo | null>(null);
  const [workspacesList, setWorkspacesList] = useState<
    Array<{ id: string; organizationName: string; name: string }>
  >([]);
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [aiProviderConfigured, setAiProviderConfigured] = useState(false);
  const [appliedMigrations, setAppliedMigrations] = useState<
    Array<{ id: string; name: string; appliedAt: string }>
  >([]);
  const [billingProviderConfigured, setBillingProviderConfigured] = useState(false);
  const [billingEvents, setBillingEvents] = useState<BillingCheckoutSession[]>([]);

  const [connections, setConnections] = useState<ConnectionProfile[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SchemaSnapshot | null>(null);
  const [selectedTableKey, setSelectedTableKey] = useState<string | null>(null);
  const [plans, setPlans] = useState<ChangePlan[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [agents, setAgents] = useState<WindowsAgentRecord[]>([]);

  const [loadingSandbox, setLoadingSandbox] = useState(false);
  const [editorInitialSql, setEditorInitialSql] = useState<string | undefined>(undefined);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Desktop Edition integration state
  const [desktopConfig, setDesktopConfig] = useState<DesktopConfig | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(256);
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [aboutTab, setAboutTab] = useState<'about' | 'logs' | 'updates'>('about');
  const [desktopLogs, setDesktopLogs] = useState<string[]>([]);
  const [updateReport, setUpdateReport] = useState<{
    enabled: boolean;
    configured: boolean;
    channel: string;
    currentVersion: string;
    available: boolean;
    message: string;
    checkedAt: string;
  } | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [triggerWizardSignal, setTriggerWizardSignal] = useState(0);
  const [triggerDiscoverySignal, setTriggerDiscoverySignal] = useState(0);

  const addToast = useCallback(
    (tone: ToastMessage['tone'], title: string, detail?: string) => {
      const id = `tst_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [...prev.slice(-3), { id, tone, title, detail }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5500);
    },
    []
  );

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  const loadWorkspaceAndData = useCallback(
    async (preferredConnId?: string | null) => {
      try {
        const [sessionRes, wsListRes, wsRes, connRes, planRes, auditRes, agentRes] = await Promise.all([
          api.getAuthSession(),
          api.listWorkspaces(),
          api.getWorkspace(),
          api.listConnections(),
          api.listPlans(),
          api.listAudit(),
          api.listAgents(),
        ]);
        setAuthSession(sessionRes);
        setWorkspacesList(wsListRes.workspaces);
        setWorkspace(wsRes.workspace);
        setAiProviderConfigured(wsRes.aiProviderConfigured);
        setAppliedMigrations(wsRes.migrations || []);
        setBillingProviderConfigured(wsRes.billingProviderConfigured);
        setBillingEvents(wsRes.billingEvents || []);
        setConnections(connRes.connections);
        setPlans(planRes.plans);
        setAuditEvents(auditRes.events);
        setAgents(agentRes.agents);

        const nextConnId =
          preferredConnId && connRes.connections.some((c) => c.id === preferredConnId)
            ? preferredConnId
            : connRes.connections.some((c) => c.id === activeConnectionId)
            ? activeConnectionId
            : connRes.connections[0]?.id ?? null;

        setActiveConnectionId(nextConnId);
        if (nextConnId) {
          try {
            const snapRes = await api.getSchema(nextConnId);
            setSnapshot(snapRes.snapshot);
            if (snapRes.snapshot.tables.length > 0) {
              setSelectedTableKey((prev) =>
                prev && snapRes.snapshot.tables.some((t) => t.fullName === prev)
                  ? prev
                  : snapRes.snapshot.tables[0].fullName
              );
            }
          } catch {
            setSnapshot(null);
          }
        } else {
          setSnapshot(null);
          setSelectedTableKey(null);
        }
      } catch (err) {
        addToast('error', 'Failed to load workspace', err instanceof Error ? err.message : 'Server error');
      }
    },
    [activeConnectionId, addToast]
  );

  useEffect(() => {
    let mounted = true;
    const boot = async () => {
      let preferredConn: string | null = null;
      if (isDesktopApp() && window.vdsDesktop) {
        try {
          const [cfg, prefs] = await Promise.all([
            getDesktopConfig(),
            window.vdsDesktop.getPreferences(),
          ]);
          if (mounted && cfg) setDesktopConfig(cfg);
          if (mounted && prefs) {
            if (prefs.mode) setMode(prefs.mode);
            if (prefs.theme === 'dark') setDarkMode(true);
            else if (prefs.theme === 'light') setDarkMode(false);
            else if (cfg) setDarkMode(cfg.systemDark);
            if (typeof prefs.sidebarWidth === 'number') setSidebarWidth(prefs.sidebarWidth);
            if (prefs.recentConnectionIds && prefs.recentConnectionIds.length > 0) {
              preferredConn = prefs.recentConnectionIds[0];
            }
          }
        } catch {
          // Ignore desktop preference boot error and continue cleanly
        }
      }
      await loadWorkspaceAndData(preferredConn);
    };
    void boot();
    return () => {
      mounted = false;
    };
  }, []);

  const activeConnection =
    connections.find((c) => c.id === activeConnectionId) ?? connections[0] ?? null;

  const refreshDesktopLogs = useCallback(async () => {
    if (!isDesktopApp() || !window.vdsDesktop) return;
    const lines = await window.vdsDesktop.readRecentLogs();
    setDesktopLogs(lines);
  }, []);

  const handleCheckDesktopUpdates = useCallback(async () => {
    if (!isDesktopApp() || !window.vdsDesktop) return;
    setCheckingUpdates(true);
    try {
      const report = await window.vdsDesktop.checkForUpdates();
      setUpdateReport(report);
      setAboutTab('updates');
      setAboutModalOpen(true);
    } finally {
      setCheckingUpdates(false);
    }
  }, []);

  const handleWipeDesktopLocalData = useCallback(async () => {
    if (!isDesktopApp() || !window.vdsDesktop) return;
    const confirmed = await window.vdsDesktop.confirmDestructiveAction({
      title: 'Delete All Local Desktop Data',
      message: 'Clear local SQLite metadata, DPAPI encrypted secrets, preferences, and window state?',
      detail: 'External SQL Server databases are NOT modified or deleted. The application will reload cleanly.',
    });
    if (!confirmed) return;
    await window.vdsDesktop.wipeLocalData();
    setAboutModalOpen(false);
    addToast('info', 'Local desktop storage cleared', 'Reloading workspace defaults...');
    await loadWorkspaceAndData(null);
  }, [addToast, loadWorkspaceAndData]);

  const handleSidebarWidthChange = useCallback((width: number) => {
    setSidebarWidth(width);
    if (isDesktopApp() && window.vdsDesktop) {
      void window.vdsDesktop.savePreferences({ sidebarWidth: width });
    }
  }, []);

  const handleToggleMode = useCallback((nextMode: AppMode) => {
    setMode(nextMode);
    if (isDesktopApp() && window.vdsDesktop) {
      void window.vdsDesktop.savePreferences({ mode: nextMode });
    }
  }, []);

  const handleToggleDark = useCallback(() => {
    setDarkMode((prev) => {
      const next = !prev;
      if (isDesktopApp() && window.vdsDesktop) {
        void window.vdsDesktop.savePreferences({ theme: next ? 'dark' : 'light' });
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isDesktopApp() || !window.vdsDesktop || !workspace) return;
    void window.vdsDesktop.updateMenuState({
      hasConnections: connections.length > 0,
      hasActiveConnection: Boolean(activeConnection),
      hasTables: Boolean(snapshot && snapshot.tables.length > 0),
      canModifySchema: canModifySchema(workspace.currentActor, activeConnection).allowed,
      canModifyData: canModifyData(workspace.currentActor, activeConnection).allowed,
      hasCriticalOperationRunning: loadingSandbox,
      mode,
      darkMode,
    });
  }, [connections.length, activeConnection, snapshot, workspace, loadingSandbox, mode, darkMode]);

  const handleLogin = async (email: string, password: string) => {
    const res = await api.login(email, password);
    setApiTenantContext({ workspaceId: res.workspaceId, actorId: '' });
    await loadWorkspaceAndData(null);
    addToast('success', `Signed in as ${res.user.name}`, res.user.email);
  };

  const handleRegister = async (input: {
    name: string;
    email: string;
    password: string;
    organizationName?: string;
  }) => {
    const res = await api.register(input);
    setApiTenantContext({ workspaceId: res.workspaceId, actorId: '' });
    await loadWorkspaceAndData(null);
    addToast('success', 'Workspace created', `Welcome, ${res.user.name}.`);
  };

  const handleLogout = async () => {
    await api.logout();
    setApiTenantContext({ workspaceId: 'ws_primary', actorId: 'usr_owner' });
    await loadWorkspaceAndData(null);
    addToast('info', 'Signed out', 'Returned to local localhost session mode.');
  };

  const handleAcceptInvitation = async (token: string, password: string) => {
    const res = await api.acceptInvitation(token, password);
    setApiTenantContext({ workspaceId: res.workspaceId, actorId: '' });
    await loadWorkspaceAndData(null);
    addToast('success', 'Invitation accepted', `Joined workspace as ${res.member.role}.`);
  };

  const handleSelectConnection = async (connId: string) => {
    setActiveConnectionId(connId);
    if (isDesktopApp() && window.vdsDesktop && connId) {
      void window.vdsDesktop.savePreferences({
        recentConnectionIds: [connId, ...connections.map((c) => c.id).filter((id) => id !== connId)].slice(0, 6),
      });
    }
    try {
      const snapRes = await api.getSchema(connId);
      setSnapshot(snapRes.snapshot);
      setSelectedTableKey(snapRes.snapshot.tables[0]?.fullName ?? null);
    } catch {
      setSnapshot(null);
    }
  };

  const handleSwitchWorkspace = async (workspaceId: string) => {
    setApiTenantContext({ workspaceId, actorId: '' });
    setActiveConnectionId(null);
    setSnapshot(null);
    await loadWorkspaceAndData(null);
    addToast('info', 'Switched workspace', 'All connections, snapshots, and logs are tenant-isolated.');
  };

  const handleSwitchActor = async (actorId: string) => {
    if (!workspace) return;
    setApiTenantContext({ workspaceId: workspace.id, actorId });
    await loadWorkspaceAndData(activeConnectionId);
  };

  const handleMountSampleSandbox = async () => {
    setLoadingSandbox(true);
    try {
      const res = await api.mountSampleSandbox();
      await loadWorkspaceAndData(res.connection.id);
      setSnapshot(res.snapshot);
      setSelectedTableKey(res.snapshot.tables[0]?.fullName ?? null);
      addToast(
        'success',
        'Interactive sample database ready',
        'NorthwindOps_Sample (SQLite sandbox) mounted in Read-Only mode.'
      );
    } catch (err) {
      addToast('error', 'Could not load sample database', err instanceof Error ? err.message : 'Error');
    } finally {
      setLoadingSandbox(false);
    }
  };

  const handleToggleReadOnly = async (conn: ConnectionProfile) => {
    try {
      await api.updateConnection(conn.id, { readOnly: !conn.readOnly });
      await loadWorkspaceAndData(conn.id);
      addToast(
        'info',
        conn.readOnly ? 'Write access enabled' : 'Connection locked to Read-Only',
        `${conn.name} is now ${conn.readOnly ? 'Read-Write' : 'Read-Only'}.`
      );
    } catch (err) {
      addToast('error', 'Permission denied', err instanceof Error ? err.message : 'Unable to change mode');
    }
  };

  const handleCheckHealth = async (conn: ConnectionProfile) => {
    try {
      const res = await api.checkConnectionHealth(conn.id);
      await loadWorkspaceAndData(conn.id);
      if (res.connection.status === 'connected') {
        addToast('success', `${conn.name} is healthy`, res.connection.engineVersion);
      } else {
        addToast('error', `${conn.name} health check failed`, res.error || res.connection.lastError || 'Unreachable');
      }
    } catch (err) {
      addToast('error', 'Health check failed', err instanceof Error ? err.message : 'Error');
    }
  };

  const handleRefreshSchema = useCallback(async () => {
    if (!activeConnection) return;
    const res = await api.refreshSchema(activeConnection.id);
    setSnapshot(res.snapshot);
    addToast('success', 'Schema refreshed', `Discovered ${res.snapshot.tables.length} tables.`);
  }, [activeConnection, addToast]);

  useEffect(() => {
    if (!isDesktopApp() || !window.vdsDesktop) return;
    const unsubscribe = window.vdsDesktop.onMenuCommand((command: DesktopMenuCommand) => {
      switch (command) {
        case 'new-connection':
          setActiveNav('connections');
          setTriggerWizardSignal((n) => n + 1);
          break;
        case 'open-connection':
        case 'nav-connections':
          setActiveNav('connections');
          break;
        case 'detect-local':
          setActiveNav('connections');
          setTriggerDiscoverySignal((n) => n + 1);
          break;
        case 'create-database':
          setActiveNav('explorer');
          break;
        case 'create-table':
          setActiveNav('table-builder');
          break;
        case 'import-data':
        case 'export-data':
          setActiveNav('records');
          break;
        case 'disconnect-active':
          setActiveConnectionId(null);
          setSnapshot(null);
          addToast('info', 'Disconnected active view', 'Select or test a connection to resume querying.');
          break;
        case 'refresh-schema':
          void handleRefreshSchema();
          break;
        case 'new-query':
        case 'nav-sql-editor':
          setActiveNav('sql-editor');
          break;
        case 'open-designer':
        case 'nav-designer':
          setActiveNav('designer');
          break;
        case 'nav-overview':
          setActiveNav('overview');
          break;
        case 'nav-explorer':
          setActiveNav('explorer');
          break;
        case 'nav-changes':
          setActiveNav('changes');
          break;
        case 'nav-audit':
          setActiveNav('audit');
          break;
        case 'nav-settings':
          setActiveNav('settings');
          break;
        case 'mode-simple':
          handleToggleMode('simple');
          break;
        case 'mode-developer':
          handleToggleMode('developer');
          break;
        case 'theme-light':
          setDarkMode(false);
          void window.vdsDesktop?.savePreferences({ theme: 'light' });
          break;
        case 'theme-dark':
          setDarkMode(true);
          void window.vdsDesktop?.savePreferences({ theme: 'dark' });
          break;
        case 'show-logs':
          void refreshDesktopLogs();
          setAboutTab('logs');
          setAboutModalOpen(true);
          break;
        case 'show-shortcuts':
          setShortcutsModalOpen(true);
          break;
        case 'check-updates':
          void handleCheckDesktopUpdates();
          break;
        case 'show-about':
          setAboutTab('about');
          setAboutModalOpen(true);
          break;
        case 'find':
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, [addToast, handleCheckDesktopUpdates, handleRefreshSchema, handleToggleMode, refreshDesktopLogs]);

  const handleStageDropTable = async (tbl: TableSchema) => {
    if (!activeConnection) return;
    try {
      await api.createPlan(activeConnection.id, `Drop table ${tbl.fullName}`, [
        { kind: 'DROP_TABLE', schemaName: tbl.schemaName, tableName: tbl.tableName },
      ]);
      await loadWorkspaceAndData(activeConnection.id);
      addToast('info', 'Destructive plan staged', 'Confirm phrase required in Change Center before execution.');
      setActiveNav('changes');
    } catch (err) {
      addToast('error', 'Unable to stage drop', err instanceof Error ? err.message : 'Permission denied');
    }
  };

  const pendingPlansCount = plans.filter(
    (p) => p.status === 'draft' || p.status === 'validated' || p.status === 'pending_approval' || p.status === 'approved'
  ).length;

  return (
    <AppShell
      activeNav={activeNav}
      onSelectNav={setActiveNav}
      mode={mode}
      onToggleMode={handleToggleMode}
      darkMode={darkMode}
      onToggleDark={handleToggleDark}
      authSession={authSession}
      onLogin={handleLogin}
      onRegister={handleRegister}
      onLogout={handleLogout}
      onAcceptInvitation={handleAcceptInvitation}
      workspace={workspace}
      workspacesList={workspacesList}
      onSwitchWorkspace={handleSwitchWorkspace}
      onSwitchActor={handleSwitchActor}
      connections={connections}
      activeConnection={activeConnection}
      onSelectConnection={handleSelectConnection}
      snapshot={snapshot}
      pendingPlansCount={pendingPlansCount}
      sidebarWidth={sidebarWidth}
      onSidebarWidthChange={handleSidebarWidthChange}
      desktopConfig={desktopConfig}
      shortcutsModalOpen={shortcutsModalOpen}
      onOpenShortcuts={() => setShortcutsModalOpen(true)}
      onCloseShortcuts={() => setShortcutsModalOpen(false)}
      aboutModalOpen={aboutModalOpen}
      aboutTab={aboutTab}
      onAboutTabChange={setAboutTab}
      onOpenAbout={(tab = 'about') => {
        if (tab === 'logs') void refreshDesktopLogs();
        setAboutTab(tab);
        setAboutModalOpen(true);
      }}
      onCloseAbout={() => setAboutModalOpen(false)}
      desktopLogs={desktopLogs}
      onRefreshLogs={() => void refreshDesktopLogs()}
      onOpenLogsFolder={() => void window.vdsDesktop?.openLogsFolder()}
      updateReport={updateReport}
      checkingUpdates={checkingUpdates}
      onCheckUpdates={() => void handleCheckDesktopUpdates()}
      onWipeLocalData={() => void handleWipeDesktopLocalData()}
      toasts={toasts}
      onDismissToast={(id) => setToasts((p) => p.filter((t) => t.id !== id))}
    >
      {activeNav === 'overview' && (
        <OverviewPage
          mode={mode}
          workspace={workspace}
          connections={connections}
          activeConnection={activeConnection}
          snapshot={snapshot}
          plans={plans}
          auditEvents={auditEvents}
          loadingSandbox={loadingSandbox}
          onMountSampleSandbox={handleMountSampleSandbox}
          onToggleReadOnly={handleToggleReadOnly}
          onCheckHealth={handleCheckHealth}
          onNavigate={setActiveNav}
        />
      )}

      {activeNav === 'connections' && (
        <ConnectionsPage
          connections={connections}
          activeConnectionId={activeConnectionId}
          agents={agents}
          triggerWizardSignal={triggerWizardSignal}
          triggerDiscoverySignal={triggerDiscoverySignal}
          onSelectConnection={handleSelectConnection}
          onRefreshAll={() => loadWorkspaceAndData(activeConnectionId)}
          onMountSampleSandbox={handleMountSampleSandbox}
          onToast={addToast}
        />
      )}

      {activeNav === 'explorer' && (
        <DatabaseExplorerPage
          mode={mode}
          connection={activeConnection}
          snapshot={snapshot}
          selectedTableKey={selectedTableKey}
          onSelectTableKey={setSelectedTableKey}
          onRefreshSchema={handleRefreshSchema}
          onRefreshAll={() => loadWorkspaceAndData(activeConnectionId)}
          onNavigate={setActiveNav}
          onStageDropTable={handleStageDropTable}
          onToast={addToast}
        />
      )}

      {activeNav === 'designer' && (
        <VisualDesignerPage
          mode={mode}
          connection={activeConnection}
          snapshot={snapshot}
          onPlanCreated={() => loadWorkspaceAndData(activeConnectionId)}
          onNavigate={setActiveNav}
          onToast={addToast}
        />
      )}

      {activeNav === 'table-builder' && (
        <TableDesignerPage
          mode={mode}
          connection={activeConnection}
          snapshot={snapshot}
          onPlanCreated={() => loadWorkspaceAndData(activeConnectionId)}
          onNavigate={setActiveNav}
          onToast={addToast}
        />
      )}

      {activeNav === 'records' && (
        <RecordsPage
          mode={mode}
          connection={activeConnection}
          snapshot={snapshot}
          actor={workspace?.currentActor ?? null}
          selectedTableKey={selectedTableKey}
          onSelectTableKey={setSelectedTableKey}
          onNavigate={setActiveNav}
          onToast={addToast}
        />
      )}

      {(activeNav === 'query-builder' || activeNav === 'sql-editor') && (
        <QueryToolsPage
          activeView={activeNav}
          connection={activeConnection}
          snapshot={snapshot}
          initialSql={editorInitialSql}
          onNavigate={setActiveNav}
          onToast={addToast}
        />
      )}

      {activeNav === 'changes' && (
        <ChangeCenterPage
          workspace={workspace}
          connections={connections}
          plans={plans}
          onRefreshAfterChange={() => loadWorkspaceAndData(activeConnectionId)}
          onNavigate={setActiveNav}
          onToast={addToast}
        />
      )}

      {activeNav === 'ai-assistant' && (
        <AiAssistantPage
          workspace={workspace}
          aiProviderConfigured={aiProviderConfigured}
          connection={activeConnection}
          snapshot={snapshot}
          onRefreshWorkspace={() => loadWorkspaceAndData(activeConnectionId)}
          onPlanCreated={() => loadWorkspaceAndData(activeConnectionId)}
          onOpenSqlInEditor={(sql) => {
            setEditorInitialSql(sql);
            setActiveNav('sql-editor');
          }}
          onNavigate={setActiveNav}
          onToast={addToast}
        />
      )}

      {activeNav === 'audit' && <AuditPage events={auditEvents} />}

      {activeNav === 'settings' && (
        <WorkspaceBillingPage
          workspace={workspace}
          migrations={appliedMigrations}
          billingProviderConfigured={billingProviderConfigured}
          billingEvents={billingEvents}
          onRefreshWorkspace={() => loadWorkspaceAndData(activeConnectionId)}
          onToast={addToast}
        />
      )}
    </AppShell>
  );
}
