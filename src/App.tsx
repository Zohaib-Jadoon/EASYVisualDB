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
  AppMode,
  AuditEvent,
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

  const [workspacesList, setWorkspacesList] = useState<
    Array<{ id: string; organizationName: string; name: string }>
  >([]);
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [aiProviderConfigured, setAiProviderConfigured] = useState(false);
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
        const [wsListRes, wsRes, connRes, planRes, auditRes, agentRes] = await Promise.all([
          api.listWorkspaces(),
          api.getWorkspace(),
          api.listConnections(),
          api.listPlans(),
          api.listAudit(),
          api.listAgents(),
        ]);
        setWorkspacesList(wsListRes.workspaces);
        setWorkspace(wsRes.workspace);
        setAiProviderConfigured(wsRes.aiProviderConfigured);
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
    loadWorkspaceAndData();
  }, []);

  const activeConnection =
    connections.find((c) => c.id === activeConnectionId) ?? connections[0] ?? null;

  const handleSelectConnection = async (connId: string) => {
    setActiveConnectionId(connId);
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
        'NorthwindOps_Sample mounted in Read-Only (Explorer) mode.'
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

  const handleRefreshSchema = async () => {
    if (!activeConnection) return;
    const res = await api.refreshSchema(activeConnection.id);
    setSnapshot(res.snapshot);
    addToast('success', 'Schema refreshed', `Discovered ${res.snapshot.tables.length} tables.`);
  };

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
      onToggleMode={setMode}
      darkMode={darkMode}
      onToggleDark={() => setDarkMode((d) => !d)}
      workspace={workspace}
      workspacesList={workspacesList}
      onSwitchWorkspace={handleSwitchWorkspace}
      onSwitchActor={handleSwitchActor}
      connections={connections}
      activeConnection={activeConnection}
      onSelectConnection={handleSelectConnection}
      snapshot={snapshot}
      pendingPlansCount={pendingPlansCount}
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
          onNavigate={setActiveNav}
        />
      )}

      {activeNav === 'connections' && (
        <ConnectionsPage
          connections={connections}
          activeConnectionId={activeConnectionId}
          agents={agents}
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
          onNavigate={setActiveNav}
          onStageDropTable={handleStageDropTable}
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
          onRefreshWorkspace={() => loadWorkspaceAndData(activeConnectionId)}
          onToast={addToast}
        />
      )}
    </AppShell>
  );
}
