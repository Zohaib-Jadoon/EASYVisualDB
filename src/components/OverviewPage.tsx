import React, { useState } from 'react';
import {
  Activity,
  ArrowRight,
  Database,
  FileCode2,
  GitBranch,
  Lock,
  Plug,
  RefreshCw,
  ShieldCheck,
  Table2,
  TableProperties,
  Unlock,
} from 'lucide-react';
import {
  AppMode,
  AuditEvent,
  ChangePlan,
  ConnectionProfile,
  SchemaSnapshot,
  WorkspaceSummary,
} from '../shared/types';
import { NavSection } from './AppShell';

interface OverviewPageProps {
  mode: AppMode;
  workspace: WorkspaceSummary | null;
  connections: ConnectionProfile[];
  activeConnection: ConnectionProfile | null;
  snapshot: SchemaSnapshot | null;
  plans: ChangePlan[];
  auditEvents: AuditEvent[];
  loadingSandbox: boolean;
  onMountSampleSandbox: () => void;
  onToggleReadOnly: (conn: ConnectionProfile) => void;
  onCheckHealth: (conn: ConnectionProfile) => Promise<void>;
  onNavigate: (nav: NavSection) => void;
}

export function OverviewPage({
  mode,
  workspace,
  connections,
  activeConnection,
  snapshot,
  plans,
  auditEvents,
  loadingSandbox,
  onMountSampleSandbox,
  onToggleReadOnly,
  onCheckHealth,
  onNavigate,
}: OverviewPageProps) {
  const [checkingHealth, setCheckingHealth] = useState(false);

  const pendingPlans = plans.filter(
    (p) => p.status === 'draft' || p.status === 'validated' || p.status === 'pending_approval' || p.status === 'approved'
  );
  const failedPlans = plans.filter((p) => p.status === 'failed');

  if (connections.length === 0) {
    return (
      <div className="max-w-5xl mx-auto space-y-8 py-4">
        <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-6 lg:p-10">
          <div className="max-w-2xl space-y-4">
            <div className="text-xs font-medium text-[#6D4AFF]">
              {workspace?.organizationName ?? 'Workspace'} · Disconnected State
            </div>
            <h1 className="font-display text-2xl lg:text-3xl font-bold tracking-tight text-[#1B2340] dark:text-white text-balance">
              No SQL Server connected — ready for setup or offline drafting
            </h1>
            <p className="text-sm lg:text-base text-slate-600 dark:text-slate-400 leading-relaxed">
              Connect a local Windows SQL Server instance, remote Windows Server, private network host via the Windows Connector Agent, or Azure SQL Database. Alternatively, mount the optional SQLite learning sandbox for offline exploration.
            </p>
            <div className="pt-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => onNavigate('connections')}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-sm font-medium transition-colors whitespace-nowrap"
              >
                <Plug className="h-4 w-4" />
                <span>Connect or Discover SQL Server</span>
              </button>
              <button
                type="button"
                disabled={loadingSandbox}
                onClick={onMountSampleSandbox}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] hover:bg-slate-100 dark:hover:bg-slate-800 text-[#1B2340] dark:text-white text-sm font-medium transition-colors whitespace-nowrap disabled:opacity-60"
              >
                <Database className="h-4 w-4 text-[#6D4AFF]" />
                <span>{loadingSandbox ? 'Preparing Sample Database...' : 'Load SQLite Learning Sandbox'}</span>
              </button>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-2">
            <div className="text-sm font-semibold text-[#1B2340] dark:text-white">
              01. Local Discovery & Agents
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Detect local Windows SQL Server instances with user consent or tunnel outbound from private networks using the Windows Connector Agent.
            </p>
          </div>
          <div className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-2">
            <div className="text-sm font-semibold text-[#1B2340] dark:text-white">
              02. Strict T-SQL & Least Privilege
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              New connections open in Explorer (Read-Only) mode. Every schema plan validates T-SQL syntax, TLS settings, and approval policies before running.
            </p>
          </div>
          <div className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-2">
            <div className="text-sm font-semibold text-[#1B2340] dark:text-white">
              03. Customer-Owned Data
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Production rows stay inside your SQL Server engine. The SaaS control plane tracks only metadata snapshots, plans, and redacted audit logs.
            </p>
          </div>
        </section>
      </div>
    );
  }

  const totalTables = snapshot?.tables.length ?? 0;
  const totalColumns = snapshot?.tables.reduce((acc, t) => acc + t.columns.length, 0) ?? 0;
  const totalFks = snapshot?.tables.reduce((acc, t) => acc + t.foreignKeys.length, 0) ?? 0;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[#1B2340] dark:text-white">
            {activeConnection?.name ?? 'Database Overview'}
          </h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-2">
            <span>{activeConnection?.engineVersion}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{activeConnection?.database}</span>
            <span aria-hidden="true">·</span>
            <span className="capitalize">{activeConnection?.environment}</span>
            <span aria-hidden="true">·</span>
            <span>
              {activeConnection?.method === 'local_sandbox'
                ? 'SQLite Sandbox Adapter'
                : activeConnection?.method === 'windows_agent'
                ? 'Windows Agent Tunnel'
                : 'Direct MSSQL T-SQL Adapter'}
            </span>
            {mode === 'developer' && snapshot && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono">Fingerprint {snapshot.fingerprint}</span>
              </>
            )}
          </p>
        </div>

        {activeConnection && (
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => onToggleReadOnly(activeConnection)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap ${
                activeConnection.readOnly
                  ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 hover:bg-amber-100'
                  : 'border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100'
              }`}
            >
              {activeConnection.readOnly ? (
                <>
                  <Lock className="h-3.5 w-3.5" />
                  <span>Read-Only (Click to Unlock Writes)</span>
                </>
              ) : (
                <>
                  <Unlock className="h-3.5 w-3.5" />
                  <span>Read-Write Enabled (Lock)</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => onNavigate('table-builder')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-xs font-medium transition-colors whitespace-nowrap"
            >
              <TableProperties className="h-3.5 w-3.5" />
              <span>{mode === 'simple' ? 'New Table' : 'Create Table (DDL)'}</span>
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-4">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Tables & Views
          </div>
          <div className="mt-2 font-display text-2xl font-bold tabular-nums text-[#1B2340] dark:text-white">
            {totalTables}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            Across {snapshot?.schemas.length ?? 1} schema(s)
          </div>
        </div>

        <div className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-4">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Fields & Relationships
          </div>
          <div className="mt-2 font-display text-2xl font-bold tabular-nums text-[#1B2340] dark:text-white">
            {totalColumns}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {totalFks} foreign key links
          </div>
        </div>

        <div className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-4">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Pending Change Plans
          </div>
          <div className="mt-2 font-display text-2xl font-bold tabular-nums text-[#1B2340] dark:text-white">
            {pendingPlans.length}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {failedPlans.length} failed execution(s)
          </div>
        </div>

        <div className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-4">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Connected Endpoints
          </div>
          <div className="mt-2 font-display text-2xl font-bold tabular-nums text-[#1B2340] dark:text-white">
            {connections.length}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {workspace?.members.filter((m) => m.status === 'active').length ?? 1} active team seat(s)
          </div>
        </div>
      </div>

      <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5">
        <h2 className="font-display text-sm font-semibold text-[#1B2340] dark:text-white">
          Quick Actions
        </h2>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <button
            type="button"
            onClick={() => onNavigate('designer')}
            className="flex items-center justify-between p-3 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] hover:border-[#6D4AFF] bg-[#F7F8FC] dark:bg-[#181F38] text-left transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <GitBranch className="h-4 w-4 text-[#6D4AFF]" />
              <div>
                <div className="text-sm font-medium text-[#1B2340] dark:text-white">Visual Designer</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">ER diagram & links</div>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-slate-400" />
          </button>

          <button
            type="button"
            onClick={() => onNavigate('records')}
            className="flex items-center justify-between p-3 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] hover:border-[#6D4AFF] bg-[#F7F8FC] dark:bg-[#181F38] text-left transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <Table2 className="h-4 w-4 text-[#6D4AFF]" />
              <div>
                <div className="text-sm font-medium text-[#1B2340] dark:text-white">Browse Records</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Spreadsheet & Excel/CSV</div>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-slate-400" />
          </button>

          <button
            type="button"
            onClick={() => onNavigate('query-builder')}
            className="flex items-center justify-between p-3 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] hover:border-[#6D4AFF] bg-[#F7F8FC] dark:bg-[#181F38] text-left transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <Database className="h-4 w-4 text-[#6D4AFF]" />
              <div>
                <div className="text-sm font-medium text-[#1B2340] dark:text-white">Query Builder</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Joins, filters & export</div>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-slate-400" />
          </button>

          <button
            type="button"
            onClick={() => onNavigate('changes')}
            className="flex items-center justify-between p-3 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] hover:border-[#6D4AFF] bg-[#F7F8FC] dark:bg-[#181F38] text-left transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <FileCode2 className="h-4 w-4 text-[#6D4AFF]" />
              <div>
                <div className="text-sm font-medium text-[#1B2340] dark:text-white">Change Center</div>
                <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  {pendingPlans.length} plan(s) queued
                </div>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-slate-400" />
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-[#1B2340] dark:text-white flex items-center gap-2">
              <Activity className={`h-4 w-4 ${activeConnection?.status === 'connected' ? 'text-[#16A66A]' : 'text-[#E5484D]'}`} />
              <span>Connection Health</span>
            </h2>
            {activeConnection && (
              <button
                type="button"
                disabled={checkingHealth}
                onClick={async () => {
                  setCheckingHealth(true);
                  try {
                    await onCheckHealth(activeConnection);
                  } finally {
                    setCheckingHealth(false);
                  }
                }}
                className="inline-flex items-center gap-1 text-xs font-medium text-[#6D4AFF] hover:underline disabled:opacity-50"
              >
                <RefreshCw className={`h-3 w-3 ${checkingHealth ? 'animate-spin' : ''}`} />
                <span>{checkingHealth ? 'Checking...' : 'Check Now'}</span>
              </button>
            )}
          </div>
          {activeConnection && (
            <dl className="space-y-2.5 text-xs">
              <div className="flex justify-between py-1.5 border-b border-[#E2E6F0] dark:border-[#232B45]">
                <dt className="text-slate-500 dark:text-slate-400">Live Status</dt>
                <dd
                  className={`font-medium capitalize ${
                    activeConnection.status === 'connected' ? 'text-[#16A66A]' : 'text-[#E5484D]'
                  }`}
                >
                  {activeConnection.status}
                </dd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-[#E2E6F0] dark:border-[#232B45]">
                <dt className="text-slate-500 dark:text-slate-400">Transport</dt>
                <dd className="font-medium text-[#1B2340] dark:text-white">
                  {activeConnection.encrypt ? 'TLS Encrypted' : 'Plaintext'}
                </dd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-[#E2E6F0] dark:border-[#232B45]">
                <dt className="text-slate-500 dark:text-slate-400">Certificate Check</dt>
                <dd className="font-medium text-[#1B2340] dark:text-white">
                  {activeConnection.trustServerCertificate ? 'Self-signed accepted' : 'Strict CA verified'}
                </dd>
              </div>
              <div className="flex justify-between py-1.5 border-b border-[#E2E6F0] dark:border-[#232B45]">
                <dt className="text-slate-500 dark:text-slate-400">SQL Permissions</dt>
                <dd className="font-medium text-[#1B2340] dark:text-white">
                  {activeConnection.capabilities.canModifySchema ? 'Metadata + Read + DDL' : 'Metadata + Read'}
                </dd>
              </div>
              <div className="flex justify-between py-1.5">
                <dt className="text-slate-500 dark:text-slate-400">Workspace Role</dt>
                <dd className="font-medium text-[#1B2340] dark:text-white flex items-center gap-1">
                  <ShieldCheck className="h-3.5 w-3.5 text-[#6D4AFF]" />
                  <span>{workspace?.currentActor.role}</span>
                </dd>
              </div>
            </dl>
          )}
        </section>

        <section className="lg:col-span-2 rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-[#1B2340] dark:text-white">
              Recent Audit Activity
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('audit')}
              className="text-xs font-medium text-[#6D4AFF] hover:underline"
            >
              View full audit log
            </button>
          </div>
          {auditEvents.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center">
              No workspace operations recorded yet.
            </p>
          ) : (
            <div className="divide-y divide-[#E2E6F0] dark:divide-[#232B45]">
              {auditEvents.slice(0, 6).map((evt) => (
                <div key={evt.id} className="py-2.5 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[#1B2340] dark:text-white flex items-center gap-2">
                      <span className="font-mono">{evt.action}</span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate text-slate-600 dark:text-slate-300">{evt.target}</span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                      {evt.actorName} ({evt.actorRole}) — {evt.detail}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <div
                      className={`text-[11px] font-medium ${
                        evt.status === 'succeeded'
                          ? 'text-[#16A66A]'
                          : evt.status === 'denied'
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-[#E5484D]'
                      }`}
                    >
                      {evt.status}
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-slate-400">
                      {new Date(evt.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
