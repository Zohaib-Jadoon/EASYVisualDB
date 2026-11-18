import React, { useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Database,
  KeyRound,
  Lock,
  Plus,
  Radar,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
  Unlock,
  XCircle,
} from 'lucide-react';
import { api } from '../lib/api';
import { isDesktopApp } from '../lib/desktopBridge';
import {
  AuthMethod,
  ConnectionDiagnosticStep,
  ConnectionMethod,
  ConnectionProfile,
  DiscoveredSqlInstance,
  EnvironmentKind,
  LocalDiscoveryResponse,
  WindowsAgentRecord,
} from '../shared/types';

interface ConnectionsPageProps {
  connections: ConnectionProfile[];
  activeConnectionId: string | null;
  agents: WindowsAgentRecord[];
  triggerWizardSignal?: number;
  triggerDiscoverySignal?: number;
  onSelectConnection: (id: string) => void;
  onRefreshAll: () => Promise<void>;
  onMountSampleSandbox: () => Promise<void>;
  onToast: (tone: 'success' | 'error' | 'info', title: string, detail?: string) => void;
}

export function ConnectionsPage({
  connections,
  activeConnectionId,
  agents,
  triggerWizardSignal,
  triggerDiscoverySignal,
  onSelectConnection,
  onRefreshAll,
  onMountSampleSandbox,
  onToast,
}: ConnectionsPageProps) {
  const [showWizard, setShowWizard] = useState(connections.length === 0);
  const [method, setMethod] = useState<Exclude<ConnectionMethod, 'local_sandbox'>>('direct_tls');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [instanceName, setInstanceName] = useState('');
  const [port, setPort] = useState(1433);
  const [database, setDatabase] = useState('');
  const [authMethod, setAuthMethod] = useState<Exclude<AuthMethod, 'sandbox_local'>>('sql_auth');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState('');
  const [encrypt, setEncrypt] = useState(true);
  const [trustServerCertificate, setTrustServerCertificate] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(15000);
  const [reconnectOnStartup, setReconnectOnStartup] = useState(true);
  const [readOnlyDefault, setReadOnlyDefault] = useState(true);
  const [environment, setEnvironment] = useState<Exclude<EnvironmentKind, 'sandbox'>>('development');
  const [selectedAgentId, setSelectedAgentId] = useState('');

  // Local SQL Discovery state (consent-initiated)
  const [discoveryAgentId, setDiscoveryAgentId] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discoveryResult, setDiscoveryResult] = useState<LocalDiscoveryResponse | null>(null);

  // Test & Database Picker state
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reconnectingAll, setReconnectingAll] = useState(false);
  const [checkingConnId, setCheckingConnId] = useState<string | null>(null);
  const [diagSteps, setDiagSteps] = useState<ConnectionDiagnosticStep[] | null>(null);
  const [diagOk, setDiagOk] = useState<boolean | null>(null);
  const [accessibleDatabases, setAccessibleDatabases] = useState<string[]>([]);

  // Windows Agent Pairing state
  const [agentName, setAgentName] = useState('');
  const [agentHost, setAgentHost] = useState('');
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  // Rotate secret modal
  const [rotateTarget, setRotateTarget] = useState<ConnectionProfile | null>(null);
  const [newSecret, setNewSecret] = useState('');
  const [windowsAuthStatus, setWindowsAuthStatus] = useState<{
    nativeSspiAvailable: boolean;
    driverName: string;
    detail: string;
  } | null>(null);

  useEffect(() => {
    api
      .getDesktopCapabilities()
      .then((res) => setWindowsAuthStatus(res.windowsAuth))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (triggerWizardSignal && triggerWizardSignal > 0) {
      setShowWizard(true);
    }
  }, [triggerWizardSignal]);

  useEffect(() => {
    if (triggerDiscoverySignal && triggerDiscoverySignal > 0) {
      void handleDiscoverLocal();
    }
  }, [triggerDiscoverySignal]);

  const handleDiscoverLocal = async () => {
    setDiscovering(true);
    try {
      const res = await api.discoverLocalSqlServers(discoveryAgentId || null);
      setDiscoveryResult(res);
      if (res.instances.length > 0) {
        onToast('success', `Discovered ${res.instances.length} SQL Server instance(s)`, 'Select an instance below to configure credentials and test.');
      } else {
        onToast('info', 'Discovery finished', res.message);
      }
    } catch (err) {
      onToast('error', 'Local discovery failed', err instanceof Error ? err.message : 'Unable to scan');
    } finally {
      setDiscovering(false);
    }
  };

  const handlePickDiscoveredInstance = (inst: DiscoveredSqlInstance) => {
    setShowWizard(true);
    if (discoveryResult?.viaAgentId) {
      setMethod('windows_agent');
      setSelectedAgentId(discoveryResult.viaAgentId);
    } else {
      setMethod('direct_tls');
    }
    setHost(inst.serverName === 'localhost' || !inst.serverName ? 'localhost' : inst.serverName);
    setInstanceName(inst.isDefaultInstance ? '' : inst.instanceName);
    setPort(inst.port ?? 1433);
    setName(`Local ${inst.fullTarget}`);
    setEnvironment('development');
    setDiagSteps(null);
    setAccessibleDatabases([]);
    onToast('info', `Selected ${inst.fullTarget}`, 'Enter credentials and click Test Connection to retrieve databases.');
  };

  const handleTest = async (e: React.FormEvent) => {
    e.preventDefault();
    setTesting(true);
    setDiagSteps(null);
    setDiagOk(null);
    setAccessibleDatabases([]);
    try {
      const res = await api.testConnection({
        method,
        host,
        instanceName: instanceName.trim() || null,
        port: Number(port) || 1433,
        database: database.trim() || 'master',
        authMethod,
        username,
        password,
        domain: domain.trim() || null,
        encrypt,
        trustServerCertificate,
        timeoutMs: Number(timeoutMs) || 15000,
        agentId: method === 'windows_agent' ? selectedAgentId || null : null,
      });
      setDiagSteps(res.steps);
      setDiagOk(res.ok);
      setAccessibleDatabases(res.accessibleDatabases || []);
      if (res.ok && !database.trim() && res.accessibleDatabases.length > 0) {
        setDatabase(res.accessibleDatabases[0]);
      }
      if (res.ok) {
        onToast('success', 'Connection verified', `${res.engineVersion} · ${res.accessibleDatabases.length} database(s) accessible.`);
      } else {
        onToast('error', 'Connection diagnostic failed', 'Inspect the step-by-step report below.');
      }
    } catch (err) {
      onToast('error', 'Test failed', err instanceof Error ? err.message : 'Invalid parameters');
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.createConnection({
        name: name.trim() || `${database || 'master'} (${host})`,
        method,
        host,
        instanceName: instanceName.trim() || null,
        port: Number(port) || 1433,
        database: database.trim() || 'master',
        authMethod,
        username,
        password,
        domain: domain.trim() || null,
        encrypt,
        trustServerCertificate,
        timeoutMs: Number(timeoutMs) || 15000,
        reconnectOnStartup,
        environment,
        readOnly: readOnlyDefault,
        agentId: method === 'windows_agent' ? selectedAgentId || null : null,
      });
      setPassword('');
      setDiagSteps(null);
      setAccessibleDatabases([]);
      setShowWizard(false);
      await onRefreshAll();
      onSelectConnection(res.connection.id);
      onToast(
        'success',
        'SQL Server connected',
        `Saved in ${readOnlyDefault ? 'Read-Only (Explorer)' : 'Read-Write'} mode.`
      );
    } catch (err: unknown) {
      const eObj = err as Error & { payload?: { diagnostics?: { steps: ConnectionDiagnosticStep[] } } };
      if (eObj.payload?.diagnostics?.steps) {
        setDiagSteps(eObj.payload.diagnostics.steps);
        setDiagOk(false);
      }
      onToast('error', 'Could not save connection', eObj.message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleReadOnly = async (conn: ConnectionProfile) => {
    try {
      await api.updateConnection(conn.id, { readOnly: !conn.readOnly });
      await onRefreshAll();
      onToast(
        'info',
        conn.readOnly ? 'Write access enabled' : 'Connection locked to Read-Only',
        `${conn.name} is now ${conn.readOnly ? 'Read-Write' : 'Read-Only'}.`
      );
    } catch (err) {
      onToast('error', 'Permission denied', err instanceof Error ? err.message : 'Unable to update mode');
    }
  };

  const handleCheckHealth = async (conn: ConnectionProfile) => {
    setCheckingConnId(conn.id);
    try {
      const res = await api.checkConnectionHealth(conn.id);
      await onRefreshAll();
      if (res.connection.status === 'connected') {
        onToast('success', `${conn.name} connected`, res.connection.engineVersion);
      } else {
        onToast('error', `${conn.name} health check failed`, res.error || res.connection.lastError || 'Unreachable');
      }
    } catch (err) {
      onToast('error', 'Health check failed', err instanceof Error ? err.message : 'Error');
    } finally {
      setCheckingConnId(null);
    }
  };

  const handleReconnectAll = async () => {
    setReconnectingAll(true);
    try {
      await api.reconnectAllConnections();
      await onRefreshAll();
      onToast('info', 'Startup reconnection check completed', 'All authorized profiles were probed.');
    } catch (err) {
      onToast('error', 'Reconnect failed', err instanceof Error ? err.message : 'Error');
    } finally {
      setReconnectingAll(false);
    }
  };

  const handleDelete = async (conn: ConnectionProfile) => {
    try {
      await api.deleteConnection(conn.id);
      await onRefreshAll();
      onToast('info', 'Connection removed', `Encrypted credentials for ${conn.name} were purged.`);
    } catch (err) {
      onToast('error', 'Failed to disconnect', err instanceof Error ? err.message : 'Error');
    }
  };

  const handleRotateSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rotateTarget || !newSecret) return;
    try {
      await api.updateConnection(rotateTarget.id, { newPassword: newSecret });
      setRotateTarget(null);
      setNewSecret('');
      await onRefreshAll();
      onToast('success', 'Secret rotated', 'Stored SQL Server credential was re-encrypted.');
    } catch (err) {
      onToast('error', 'Rotation failed', err instanceof Error ? err.message : 'Error');
    }
  };

  const handlePairAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.pairAgent(agentName, agentHost);
      setIssuedToken(res.oneTimeToken);
      setAgentName('');
      setAgentHost('');
      await onRefreshAll();
      onToast('success', 'Pairing token issued', 'Copy the one-time token now; it will not be shown again.');
    } catch (err) {
      onToast('error', 'Pairing failed', err instanceof Error ? err.message : 'Error');
    }
  };

  const onlineAgents = agents.filter((a) => a.status === 'online');
  const wsServerOrigin =
    typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/agent-ws`
      : 'ws://localhost:3000/agent-ws';

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[#1B2340] dark:text-white">
            Database Connections & Discovery
          </h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Detect local Windows SQL Server instances, configure TLS or Windows Auth endpoints, or tunnel through an outbound Windows Connector Agent.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {connections.length > 0 && (
            <button
              type="button"
              disabled={reconnectingAll}
              onClick={handleReconnectAll}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] text-xs font-medium text-[#1B2340] dark:text-white hover:bg-slate-50 dark:hover:bg-[#181F38] whitespace-nowrap disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${reconnectingAll ? 'animate-spin' : ''}`} />
              <span>Reconnect Saved</span>
            </button>
          )}
          {!connections.some((c) => c.method === 'local_sandbox') && (
            <button
              type="button"
              onClick={onMountSampleSandbox}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] text-xs font-medium text-[#1B2340] dark:text-white hover:bg-slate-50 dark:hover:bg-[#181F38] whitespace-nowrap"
            >
              <Database className="h-3.5 w-3.5 text-[#6D4AFF]" />
              <span>Load SQLite Sandbox</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowWizard((v) => !v)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-xs font-medium transition-colors whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{showWizard ? 'Hide Connection Wizard' : 'Connect SQL Server'}</span>
          </button>
        </div>
      </div>

      {/* Consent-Gated Local SQL Server Discovery Panel */}
      <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h2 className="font-display text-sm font-semibold text-[#1B2340] dark:text-white flex items-center gap-2">
              <Radar className="h-4 w-4 text-[#6D4AFF]" />
              <span>Detect Local SQL Servers</span>
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {isDesktopApp()
                ? 'Desktop Direct Discovery: scans local Windows SQL Server services, registry instances, and SQL Browser directly on your Windows PC without installing a separate Connector Agent.'
                : 'User-initiated scan via local Windows host services/registry (on Windows localhost) or an online Windows Connector Agent. Never opens confidential databases automatically.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onlineAgents.length > 0 && (
              <select
                aria-label="Select discovery agent"
                value={discoveryAgentId}
                onChange={(e) => setDiscoveryAgentId(e.target.value)}
                className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-xs text-[#1B2340] dark:text-white"
              >
                <option value="">This Local Host</option>
                {onlineAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    Via Agent: {a.name} ({a.hostname})
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              disabled={discovering}
              onClick={handleDiscoverLocal}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#1B2340] dark:bg-[#6D4AFF] text-white text-xs font-medium hover:opacity-90 disabled:opacity-50 whitespace-nowrap"
            >
              <Radar className={`h-3.5 w-3.5 ${discovering ? 'animate-spin' : ''}`} />
              <span>{discovering ? 'Scanning SQL Services...' : 'Detect Local SQL Servers'}</span>
            </button>
          </div>
        </div>

        {discoveryResult && (
          <div className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-medium text-[#1B2340] dark:text-white">
                {discoveryResult.message}
              </span>
              <span className="text-slate-400 font-mono">
                Platform: {discoveryResult.hostPlatform} · {new Date(discoveryResult.checkedAt).toLocaleTimeString()}
              </span>
            </div>

            {discoveryResult.instances.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {discoveryResult.instances.map((inst) => (
                  <div
                    key={inst.id}
                    className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] p-3 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-xs font-semibold text-[#1B2340] dark:text-white truncate">
                        {inst.fullTarget}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        Status: {inst.serviceStatus} ({inst.availability}) ·{' '}
                        {inst.port ? `Port ${inst.port}` : 'Dynamic port'} · {inst.version}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handlePickDiscoveredInstance(inst)}
                      className="px-3 py-1.5 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium shrink-0 hover:bg-[#5B38F0]"
                    >
                      Use Instance
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                No local Windows SQL Server instances were reported in this environment. Use the manual Connection Wizard below for remote SQL Servers, Azure SQL, or run on Windows 11 localhost.
              </p>
            )}
          </div>
        )}
      </section>

      {/* Step-by-Step Connection Wizard */}
      {showWizard && (
        <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-4 border-b border-[#E2E6F0] dark:border-[#232B45]">
            <div>
              <h2 className="font-display text-base font-semibold text-[#1B2340] dark:text-white">
                Manual & Discovered SQL Server Connection Setup
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Supports named instances, Windows Integrated NTLM auth, SQL auth, strict TLS validation, and Read-Only explorer defaults.
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 rounded-lg bg-[#F1F3F9] dark:bg-[#181F38]">
              {(
                [
                  { id: 'direct_tls', label: 'Direct / Local TCP' },
                  { id: 'azure_sql', label: 'Azure SQL' },
                  { id: 'windows_agent', label: 'Windows Agent' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    setMethod(opt.id);
                    if (opt.id === 'azure_sql') setEncrypt(true);
                  }}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                    method === opt.id
                      ? 'bg-white dark:bg-[#12172B] text-[#6D4AFF] shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-[#1B2340] dark:hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={handleSave} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="conn-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Connection Name
              </label>
              <input
                id="conn-name"
                type="text"
                required
                placeholder="e.g., Local SQLEXPRESS or Staging Orders"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm text-[#1B2340] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
              />
            </div>

            <div>
              <label htmlFor="conn-env" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Environment Classification
              </label>
              <select
                id="conn-env"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value as Exclude<EnvironmentKind, 'sandbox'>)}
                className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm text-[#1B2340] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
              >
                <option value="development">Development</option>
                <option value="staging">Staging</option>
                <option value="production">Production (Approval Gated)</option>
              </select>
            </div>

            <div>
              <label htmlFor="conn-host" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                {method === 'azure_sql' ? 'Azure SQL Server Hostname' : 'Server Hostname / IP'}
              </label>
              <input
                id="conn-host"
                type="text"
                required
                placeholder={method === 'azure_sql' ? 'myserver.database.windows.net' : 'localhost or 192.168.1.50'}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm font-mono text-[#1B2340] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
              />
            </div>

            <div className="grid grid-cols-3 gap-2.5">
              <div>
                <label htmlFor="conn-instance" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Instance (Optional)
                </label>
                <input
                  id="conn-instance"
                  type="text"
                  placeholder="SQLEXPRESS"
                  value={instanceName}
                  onChange={(e) => setInstanceName(e.target.value)}
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2.5 py-2 text-sm font-mono text-[#1B2340] dark:text-white"
                />
              </div>
              <div>
                <label htmlFor="conn-port" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Port
                </label>
                <input
                  id="conn-port"
                  type="number"
                  required
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2.5 py-2 text-sm font-mono tabular-nums text-[#1B2340] dark:text-white"
                />
              </div>
              <div>
                <label htmlFor="conn-timeout" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Timeout (ms)
                </label>
                <input
                  id="conn-timeout"
                  type="number"
                  min={2000}
                  max={60000}
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(Number(e.target.value))}
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2.5 py-2 text-sm font-mono tabular-nums text-[#1B2340] dark:text-white"
                />
              </div>
            </div>

            <div>
              <label htmlFor="conn-auth-method" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Authentication Method
              </label>
              <select
                id="conn-auth-method"
                value={authMethod}
                onChange={(e) => setAuthMethod(e.target.value as Exclude<AuthMethod, 'sandbox_local'>)}
                className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm text-[#1B2340] dark:text-white"
              >
                <option value="sql_auth">SQL Server Authentication (Username / Password)</option>
                <option value="windows_integrated">Windows Authentication (NTLM Domain / User)</option>
                <option value="entra_id">Microsoft Entra ID (Password / Access Token)</option>
              </select>
            </div>

            <div>
              <label htmlFor="conn-db" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Database Selection {accessibleDatabases.length > 0 ? `(${accessibleDatabases.length} discovered)` : ''}
              </label>
              {accessibleDatabases.length > 0 ? (
                <select
                  id="conn-db"
                  value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                  className="w-full rounded-lg border border-[#6D4AFF] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm font-mono text-[#1B2340] dark:text-white"
                >
                  {accessibleDatabases.map((dbName) => (
                    <option key={dbName} value={dbName}>
                      {dbName}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="conn-db"
                  type="text"
                  placeholder="Test connection first or enter DB name (default: master)"
                  value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm font-mono text-[#1B2340] dark:text-white"
                />
              )}
            </div>

            {authMethod === 'windows_integrated' && (
              <div className="md:col-span-2 space-y-2.5">
                {windowsAuthStatus && (
                  <div className="rounded-lg border border-amber-300/70 dark:border-amber-800/70 bg-amber-50/70 dark:bg-amber-950/30 p-3 text-xs text-amber-900 dark:text-amber-200">
                    <strong>
                      {windowsAuthStatus.nativeSspiAvailable
                        ? 'Native Windows SSPI Driver Detected'
                        : 'Windows NTLM Credentials Mode (Passwordless SSPI Unavailable)'}
                    </strong>
                    <p className="mt-0.5 text-[11px] opacity-90">{windowsAuthStatus.detail}</p>
                  </div>
                )}
                <div>
                  <label htmlFor="conn-domain" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Windows Domain / Machine Name (for NTLM Authentication)
                  </label>
                  <input
                    id="conn-domain"
                    type="text"
                    placeholder="WORKGROUP or CORP_DOMAIN or COMPUTERNAME"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm font-mono text-[#1B2340] dark:text-white"
                  />
                </div>
              </div>
            )}

            <div>
              <label htmlFor="conn-user" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                {authMethod === 'windows_integrated' ? 'Windows Account Username' : 'SQL Login / Username'}
              </label>
              <input
                id="conn-user"
                type="text"
                required
                placeholder={authMethod === 'windows_integrated' ? 'Administrator or zohaib' : 'vds_reader_writer'}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm font-mono text-[#1B2340] dark:text-white"
              />
            </div>

            <div>
              <label htmlFor="conn-pass" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Password (AES-256-GCM Encrypted on Server)
              </label>
              <input
                id="conn-pass"
                type="password"
                required={authMethod === 'sql_auth' || authMethod === 'windows_integrated'}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm text-[#1B2340] dark:text-white"
              />
            </div>

            {method === 'windows_agent' && (
              <div className="md:col-span-2">
                <label htmlFor="conn-agent" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Registered Windows Connector Agent
                </label>
                <select
                  id="conn-agent"
                  required
                  value={selectedAgentId}
                  onChange={(e) => setSelectedAgentId(e.target.value)}
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm text-[#1B2340] dark:text-white"
                >
                  <option value="">Select an approved outbound Windows agent...</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.hostname} · {a.status})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={encrypt}
                  onChange={(e) => setEncrypt(e.target.checked)}
                  className="rounded border-slate-300 text-[#6D4AFF] focus:ring-[#6D4AFF]"
                />
                <span>Require Encrypted TLS Transport (Recommended)</span>
              </label>

              <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={trustServerCertificate}
                  onChange={(e) => setTrustServerCertificate(e.target.checked)}
                  className="rounded border-slate-300 text-[#6D4AFF] focus:ring-[#6D4AFF]"
                />
                <span>Explicitly Trust Self-Signed Cert (Never Silent)</span>
              </label>

              <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={readOnlyDefault}
                  onChange={(e) => setReadOnlyDefault(e.target.checked)}
                  className="rounded border-slate-300 text-[#6D4AFF] focus:ring-[#6D4AFF]"
                />
                <span>Save in Read-Only (Explorer) Mode Initially</span>
              </label>

              <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={reconnectOnStartup}
                  onChange={(e) => setReconnectOnStartup(e.target.checked)}
                  className="rounded border-slate-300 text-[#6D4AFF] focus:ring-[#6D4AFF]"
                />
                <span>Reconnect Automatically on Server Startup</span>
              </label>
            </div>

            {diagSteps && (
              <div className="md:col-span-2 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] p-4 space-y-2.5">
                <div className="text-xs font-semibold text-[#1B2340] dark:text-white">
                  Connection Diagnostic Report {diagOk ? '— Verified & Ready' : '— Action Required'}
                </div>
                <div className="space-y-2">
                  {diagSteps.map((s) => (
                    <div key={s.step} className="flex items-start justify-between gap-3 text-xs">
                      <div className="flex items-start gap-2">
                        {s.status === 'passed' ? (
                          <CheckCircle2 className="h-4 w-4 text-[#16A66A] shrink-0 mt-0.5" />
                        ) : s.status === 'failed' ? (
                          <XCircle className="h-4 w-4 text-[#E5484D] shrink-0 mt-0.5" />
                        ) : (
                          <ShieldAlert className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />
                        )}
                        <div>
                          <div className="font-medium text-[#1B2340] dark:text-white">{s.label}</div>
                          <div className="text-slate-500 dark:text-slate-400">{s.detail}</div>
                        </div>
                      </div>
                      <span className="font-mono tabular-nums text-slate-400 shrink-0">
                        {s.durationMs}ms
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="md:col-span-2 flex flex-wrap items-center justify-end gap-3 pt-2 border-t border-[#E2E6F0] dark:border-[#232B45]">
              <button
                type="button"
                disabled={testing || !host || !username}
                onClick={handleTest}
                className="px-4 py-2 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#181F38] text-xs font-medium text-[#1B2340] dark:text-white hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
              >
                {testing ? 'Testing Host, TLS & Listing DBs...' : 'Test Connection & Fetch Databases'}
              </button>
              <button
                type="submit"
                disabled={saving || !host || !username}
                className="px-4 py-2 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-xs font-medium disabled:opacity-50"
              >
                {saving ? 'Verifying & Encrypting...' : 'Save Connection'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Active Connections Table */}
      <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E2E6F0] dark:border-[#232B45] flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold text-[#1B2340] dark:text-white">
            Registered Database Profiles ({connections.length})
          </h2>
        </div>
        {connections.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
            No connections registered in this workspace yet. Use Local Discovery, the Connection Wizard above, or load the SQLite sandbox.
          </div>
        ) : (
          <div className="divide-y divide-[#E2E6F0] dark:divide-[#232B45]">
            {connections.map((conn) => {
              const isSelected = conn.id === activeConnectionId;
              return (
                <div
                  key={conn.id}
                  className={`p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 ${
                    isSelected ? 'bg-[#6D4AFF]/5 dark:bg-[#6D4AFF]/10' : ''
                  }`}
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onSelectConnection(conn.id)}
                        className="font-display text-sm font-semibold text-[#1B2340] dark:text-white hover:text-[#6D4AFF] text-left"
                      >
                        {conn.name}
                      </button>
                      {isSelected && (
                        <span className="text-[11px] font-medium text-[#6D4AFF]">· Active</span>
                      )}
                      <span
                        className={`text-[11px] font-medium ${
                          conn.status === 'connected' ? 'text-[#16A66A]' : 'text-[#E5484D]'
                        }`}
                      >
                        · {conn.status}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-2">
                      <span className="font-mono">
                        {conn.host}
                        {conn.instanceName ? `\\${conn.instanceName}` : `:${conn.port}`}/{conn.database}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="capitalize">{conn.environment}</span>
                      <span aria-hidden="true">·</span>
                      <span>{conn.engineVersion}</span>
                      {conn.reconnectOnStartup && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>Auto-reconnect</span>
                        </>
                      )}
                    </div>
                    {conn.lastError && (
                      <div className="text-[11px] text-[#E5484D]">{conn.lastError}</div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onSelectConnection(conn.id)}
                      className="px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs font-medium text-[#1B2340] dark:text-white hover:bg-slate-50 dark:hover:bg-[#181F38]"
                    >
                      {isSelected ? 'Selected' : 'Use Connection'}
                    </button>

                    <button
                      type="button"
                      disabled={checkingConnId === conn.id}
                      onClick={() => handleCheckHealth(conn)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#181F38]"
                    >
                      <Activity className="h-3.5 w-3.5 text-[#16A66A]" />
                      <span>{checkingConnId === conn.id ? 'Checking...' : 'Check'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleToggleReadOnly(conn)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium ${
                        conn.readOnly
                          ? 'border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300'
                          : 'border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300'
                      }`}
                    >
                      {conn.readOnly ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                      <span>{conn.readOnly ? 'Read-Only' : 'Read-Write'}</span>
                    </button>

                    {conn.method !== 'local_sandbox' && (
                      <button
                        type="button"
                        onClick={() => setRotateTarget(conn)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-[#181F38]"
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                        <span>Rotate Secret</span>
                      </button>
                    )}

                    <button
                      type="button"
                      aria-label={`Disconnect ${conn.name}`}
                      onClick={() => handleDelete(conn)}
                      className="p-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-slate-500 hover:text-[#E5484D] hover:border-[#E5484D]/50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Windows Connector Agent (On-Premise Private Networks) */}
      <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4">
        <div>
          <h2 className="font-display text-sm font-semibold text-[#1B2340] dark:text-white flex items-center gap-2">
            <Server className="h-4 w-4 text-[#6D4AFF]" />
            <span>Windows Connector Agents (Private SQL Server Tunnel)</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Run <span className="font-mono">agent/</span> on Windows 11 or Windows Server to connect private SQL instances over outbound WebSocket without exposing port 1433.
          </p>
        </div>

        <form onSubmit={handlePairAgent} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input
            type="text"
            required
            placeholder="Agent label (e.g. Win11-Workstation)"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-xs text-[#1B2340] dark:text-white"
          />
          <input
            type="text"
            required
            placeholder="Windows PC / Server hostname"
            value={agentHost}
            onChange={(e) => setAgentHost(e.target.value)}
            className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-xs font-mono text-[#1B2340] dark:text-white"
          />
          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-[#1B2340] dark:bg-[#6D4AFF] text-white text-xs font-medium hover:opacity-90"
          >
            Issue Expiring Pairing Token
          </button>
        </form>

        {issuedToken && (
          <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
            <div className="text-xs font-semibold text-amber-900 dark:text-amber-200">
              One-Time Pairing Token (Copy now — hashed in DB and never displayed again)
            </div>
            <pre className="text-xs font-mono text-amber-950 dark:text-amber-100 overflow-x-auto select-all">
              {`npm --prefix agent start -- --server "${wsServerOrigin}" --token "${issuedToken}"`}
            </pre>
            <div className="text-[11px] text-amber-800 dark:text-amber-300">
              Or install permanently as a Windows Service using <span className="font-mono">agent/scripts/install-service.ps1</span>.
            </div>
          </div>
        )}

        {agents.length > 0 && (
          <div className="divide-y divide-[#E2E6F0] dark:divide-[#232B45] border-t border-[#E2E6F0] dark:border-[#232B45]">
            {agents.map((a) => (
              <div key={a.id} className="py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div>
                  <span className="font-medium text-[#1B2340] dark:text-white">{a.name}</span>
                  <span className="mx-2 text-slate-400">·</span>
                  <span className="font-mono text-slate-500 dark:text-slate-400">{a.hostname}</span>
                  <span className="mx-2 text-slate-400">·</span>
                  <span className="capitalize">{a.status.replace('_', ' ')}</span>
                  {a.discoveredInstancesCount !== undefined && (
                    <>
                      <span className="mx-2 text-slate-400">·</span>
                      <span className="tabular-nums">{a.discoveredInstancesCount} SQL instances detected</span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {a.status === 'pending_approval' && (
                    <button
                      type="button"
                      onClick={async () => {
                        await api.updateAgentStatus(a.id, 'online');
                        await onRefreshAll();
                      }}
                      className="px-2.5 py-1 rounded bg-[#16A66A] text-white font-medium"
                    >
                      Approve Device
                    </button>
                  )}
                  {a.status !== 'revoked' && (
                    <button
                      type="button"
                      onClick={async () => {
                        await api.updateAgentStatus(a.id, 'revoked');
                        await onRefreshAll();
                      }}
                      className="px-2.5 py-1 rounded border border-[#E2E6F0] dark:border-[#232B45] text-[#E5484D]"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {rotateTarget && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/50">
          <form
            onSubmit={handleRotateSecret}
            className="w-full max-w-md rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4"
          >
            <h3 className="font-display text-base font-semibold text-[#1B2340] dark:text-white">
              Rotate Credential for {rotateTarget.name}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Enter the updated SQL login password. It will be encrypted immediately using AES-256-GCM on the server.
            </p>
            <input
              type="password"
              required
              autoFocus
              placeholder="New SQL Server password"
              value={newSecret}
              onChange={(e) => setNewSecret(e.target.value)}
              className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm text-[#1B2340] dark:text-white"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRotateTarget(null)}
                className="px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3 py-1.5 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium"
              >
                Rotate & Encrypt
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
