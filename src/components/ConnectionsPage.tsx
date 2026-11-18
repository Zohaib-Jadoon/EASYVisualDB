import React, { useState } from 'react';
import {
  CheckCircle2,
  Database,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
  Unlock,
  XCircle,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  ConnectionDiagnosticStep,
  ConnectionMethod,
  ConnectionProfile,
  EnvironmentKind,
  WindowsAgentRecord,
} from '../shared/types';

interface ConnectionsPageProps {
  connections: ConnectionProfile[];
  activeConnectionId: string | null;
  agents: WindowsAgentRecord[];
  onSelectConnection: (id: string) => void;
  onRefreshAll: () => Promise<void>;
  onMountSampleSandbox: () => Promise<void>;
  onToast: (tone: 'success' | 'error' | 'info', title: string, detail?: string) => void;
}

export function ConnectionsPage({
  connections,
  activeConnectionId,
  agents,
  onSelectConnection,
  onRefreshAll,
  onMountSampleSandbox,
  onToast,
}: ConnectionsPageProps) {
  const [showWizard, setShowWizard] = useState(connections.length === 0);
  const [method, setMethod] = useState<Exclude<ConnectionMethod, 'local_sandbox'>>('direct_tls');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(1433);
  const [database, setDatabase] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [encrypt, setEncrypt] = useState(true);
  const [trustServerCertificate, setTrustServerCertificate] = useState(false);
  const [environment, setEnvironment] = useState<Exclude<EnvironmentKind, 'sandbox'>>('development');
  const [selectedAgentId, setSelectedAgentId] = useState('');

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [diagSteps, setDiagSteps] = useState<ConnectionDiagnosticStep[] | null>(null);
  const [diagOk, setDiagOk] = useState<boolean | null>(null);

  // Windows Agent Pairing state
  const [agentName, setAgentName] = useState('');
  const [agentHost, setAgentHost] = useState('');
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  // Rotate secret modal
  const [rotateTarget, setRotateTarget] = useState<ConnectionProfile | null>(null);
  const [newSecret, setNewSecret] = useState('');

  const handleTest = async (e: React.FormEvent) => {
    e.preventDefault();
    setTesting(true);
    setDiagSteps(null);
    setDiagOk(null);
    try {
      const res = await api.testConnection({
        host,
        port: Number(port) || 1433,
        database,
        username,
        password,
        encrypt,
        trustServerCertificate,
      });
      setDiagSteps(res.steps);
      setDiagOk(res.ok);
      if (res.ok) {
        onToast('success', 'Connection verified', `${res.engineVersion}`);
      } else {
        onToast('error', 'Connection diagnostic failed', 'Check the step-by-step report below.');
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
        name: name.trim() || `${database} (${host})`,
        method,
        host,
        port: Number(port) || 1433,
        database,
        authMethod: 'sql_auth',
        username,
        password,
        encrypt,
        trustServerCertificate,
        environment,
        readOnly: true,
        agentId: method === 'windows_agent' ? selectedAgentId || null : null,
      });
      setPassword('');
      setDiagSteps(null);
      setShowWizard(false);
      await onRefreshAll();
      onSelectConnection(res.connection.id);
      onToast(
        'success',
        'SQL Server connected',
        'Created in Read-Only (Explorer) mode per least-privilege policy.'
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

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[#1B2340] dark:text-white">
            Database Connections
          </h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Encrypted SQL Server endpoints and outbound Windows Connector Agents. Passwords remain server-side only.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {!connections.some((c) => c.method === 'local_sandbox') && (
            <button
              type="button"
              onClick={onMountSampleSandbox}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] text-xs font-medium text-[#1B2340] dark:text-white hover:bg-slate-50 dark:hover:bg-[#181F38] whitespace-nowrap"
            >
              <Database className="h-3.5 w-3.5 text-[#6D4AFF]" />
              <span>Load Sample Sandbox</span>
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

      {/* Step-by-Step Connection Wizard */}
      {showWizard && (
        <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-4 border-b border-[#E2E6F0] dark:border-[#232B45]">
            <div>
              <h2 className="font-display text-base font-semibold text-[#1B2340] dark:text-white">
                New SQL Server Connection Wizard
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                All new connections start in Read-Only (Explorer) mode and validate TLS certificates by default.
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 rounded-lg bg-[#F1F3F9] dark:bg-[#181F38]">
              {(
                [
                  { id: 'direct_tls', label: 'Direct TLS' },
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
                Friendly Connection Name
              </label>
              <input
                id="conn-name"
                type="text"
                required
                placeholder="e.g., Production Orders DB"
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
                {method === 'azure_sql' ? 'Azure SQL Server Hostname' : 'SQL Server Host / IP'}
              </label>
              <input
                id="conn-host"
                type="text"
                required
                placeholder={method === 'azure_sql' ? 'myserver.database.windows.net' : 'sql.internal.company.com'}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm font-mono text-[#1B2340] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
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
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm font-mono tabular-nums text-[#1B2340] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
                />
              </div>
              <div>
                <label htmlFor="conn-db" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Database Name
                </label>
                <input
                  id="conn-db"
                  type="text"
                  required
                  placeholder="OperationsDB"
                  value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm font-mono text-[#1B2340] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
                />
              </div>
            </div>

            <div>
              <label htmlFor="conn-user" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Least-Privilege SQL Login
              </label>
              <input
                id="conn-user"
                type="text"
                required
                placeholder="vds_reader_writer"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm font-mono text-[#1B2340] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
              />
            </div>

            <div>
              <label htmlFor="conn-pass" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Password (Encrypted on Server)
              </label>
              <input
                id="conn-pass"
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm text-[#1B2340] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
              />
            </div>

            {method === 'windows_agent' && (
              <div className="md:col-span-2">
                <label htmlFor="conn-agent" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Registered Windows Connector Agent
                </label>
                <select
                  id="conn-agent"
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

            <div className="md:col-span-2 flex flex-wrap items-center gap-6 pt-1">
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
                <span>Allow Self-Signed Server Certificate (Non-Prod Only)</span>
              </label>
            </div>

            {/* Diagnostic Results */}
            {diagSteps && (
              <div className="md:col-span-2 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] p-4 space-y-2.5">
                <div className="text-xs font-semibold text-[#1B2340] dark:text-white">
                  Connection Diagnostic Report {diagOk ? '— Ready to Save' : '— Action Required'}
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
                disabled={testing || !host || !database || !username || !password}
                onClick={handleTest}
                className="px-4 py-2 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#181F38] text-xs font-medium text-[#1B2340] dark:text-white hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
              >
                {testing ? 'Testing Host, TLS & Permissions...' : 'Test Connection'}
              </button>
              <button
                type="submit"
                disabled={saving || !host || !database || !username || !password}
                className="px-4 py-2 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-xs font-medium disabled:opacity-50"
              >
                {saving ? 'Verifying & Encrypting...' : 'Save Read-Only Connection'}
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
            No SQL Server connections saved in this workspace yet. Use the wizard above or load the interactive sample sandbox.
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
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-2">
                      <span className="font-mono">{conn.host}:{conn.port}/{conn.database}</span>
                      <span aria-hidden="true">·</span>
                      <span className="capitalize">{conn.environment}</span>
                      <span aria-hidden="true">·</span>
                      <span>{conn.engineVersion}</span>
                    </div>
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
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h2 className="font-display text-sm font-semibold text-[#1B2340] dark:text-white flex items-center gap-2">
              <Server className="h-4 w-4 text-[#6D4AFF]" />
              <span>Windows Connector Agents (Private SQL Server)</span>
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Connect on-premise Windows Server SQL instances over outbound TLS without opening inbound firewall port 1433.
            </p>
          </div>
        </div>

        <form onSubmit={handlePairAgent} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input
            type="text"
            required
            placeholder="Agent label (e.g. Lahore-SQL-01)"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-xs text-[#1B2340] dark:text-white"
          />
          <input
            type="text"
            required
            placeholder="Windows Server hostname"
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
          <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-1.5">
            <div className="text-xs font-semibold text-amber-900 dark:text-amber-200">
              One-Time Pairing Token (Copy now — never stored in plaintext)
            </div>
            <pre className="text-xs font-mono text-amber-950 dark:text-amber-100 overflow-x-auto select-all">
              {`vds-agent.exe pair --token "${issuedToken}" --server "https://studio.example/agent-gateway"`}
            </pre>
          </div>
        )}

        {agents.length > 0 && (
          <div className="divide-y divide-[#E2E6F0] dark:divide-[#232B45] border-t border-[#E2E6F0] dark:border-[#232B45]">
            {agents.map((a) => (
              <div key={a.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                <div>
                  <span className="font-medium text-[#1B2340] dark:text-white">{a.name}</span>
                  <span className="mx-2 text-slate-400">·</span>
                  <span className="font-mono text-slate-500 dark:text-slate-400">{a.hostname}</span>
                  <span className="mx-2 text-slate-400">·</span>
                  <span className="capitalize">{a.status.replace('_', ' ')}</span>
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

      {/* Secret Rotation Dialog */}
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
