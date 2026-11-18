import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  GitCompare,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import { api } from '../lib/api';
import { canApproveChangePlan, canModifySchema } from '../shared/permissions';
import {
  ChangePlan,
  ConnectionProfile,
  SchemaDriftReport,
  WorkspaceSummary,
} from '../shared/types';
import { NavSection } from './AppShell';

interface ChangeCenterPageProps {
  workspace: WorkspaceSummary | null;
  connections: ConnectionProfile[];
  plans: ChangePlan[];
  onRefreshAfterChange: () => Promise<void>;
  onNavigate: (nav: NavSection) => void;
  onToast: (tone: 'success' | 'error' | 'info', title: string, detail?: string) => void;
}

export function ChangeCenterPage({
  workspace,
  connections,
  plans,
  onRefreshAfterChange,
  onNavigate,
  onToast,
}: ChangeCenterPageProps) {
  const [selectedPlanId, setSelectedPlanId] = useState<string>(plans[0]?.id ?? '');
  const [confirmInputs, setConfirmInputs] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [driftReports, setDriftReports] = useState<Record<string, SchemaDriftReport>>({});
  const [checkingDrift, setCheckingDrift] = useState(false);

  const selectedPlan = plans.find((p) => p.id === selectedPlanId) ?? plans[0] ?? null;
  const targetConnection = selectedPlan
    ? connections.find((c) => c.id === selectedPlan.connectionId) ?? null
    : null;

  const handleCheckDrift = async (plan: ChangePlan) => {
    setCheckingDrift(true);
    try {
      const res = await api.checkPlanDrift(plan.id);
      setDriftReports((prev) => ({ ...prev, [plan.id]: res.report }));
      if (res.report.drifted) {
        onToast('error', 'Schema drift detected', res.report.summary);
      } else {
        onToast('success', 'No schema drift', res.report.summary);
      }
    } catch (err) {
      onToast('error', 'Drift check failed', err instanceof Error ? err.message : 'Error');
    } finally {
      setCheckingDrift(false);
    }
  };

  const handleRevalidate = async (plan: ChangePlan) => {
    setBusyId(plan.id);
    try {
      await api.revalidatePlan(plan.id);
      setDriftReports((prev) => {
        const next = { ...prev };
        delete next[plan.id];
        return next;
      });
      await onRefreshAfterChange();
      onToast('success', 'Plan revalidated against live schema', 'Fingerprint and preflight checks updated.');
    } catch (err) {
      onToast('error', 'Revalidation failed', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDiscard = async (plan: ChangePlan) => {
    setBusyId(plan.id);
    try {
      await api.deletePlan(plan.id);
      await onRefreshAfterChange();
      onToast('info', 'Draft discarded', `${plan.title} was deleted.`);
    } catch (err) {
      onToast('error', 'Could not discard plan', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusyId(null);
    }
  };

  const handleApprove = async (plan: ChangePlan) => {
    setBusyId(plan.id);
    try {
      await api.approvePlan(plan.id);
      await onRefreshAfterChange();
      onToast('success', 'Change plan approved', `${plan.title} is ready for execution.`);
    } catch (err) {
      onToast('error', 'Approval blocked', err instanceof Error ? err.message : 'Policy denied');
    } finally {
      setBusyId(null);
    }
  };

  const handleExecute = async (plan: ChangePlan) => {
    setBusyId(plan.id);
    try {
      const res = await api.executePlan(plan.id, confirmInputs[plan.id]);
      await onRefreshAfterChange();
      onToast(
        'success',
        'Applied to database',
        res.plan.executionSummary || 'Schema snapshot refreshed.'
      );
    } catch (err) {
      await onRefreshAfterChange();
      onToast('error', 'Execution blocked or failed', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusyId(null);
    }
  };

  const activeDrift = selectedPlan ? driftReports[selectedPlan.id] : undefined;

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#1B2340] dark:text-white">
            Change Center
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Draft → Validate → Drift Check → Approve → Execute → Audit. No schema change runs without review.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('table-builder')}
          className="px-3.5 py-2 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-xs font-medium self-start sm:self-auto"
        >
          New Table Design
        </button>
      </div>

      <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/20 px-4 py-3 text-xs text-amber-900 dark:text-amber-200">
        <strong>Recovery Boundary:</strong> Application audit logs and schema snapshots are not SQL Server backups. Ensure your SQL Server backup/restore policy is current before executing destructive DDL.
      </div>

      {plans.length === 0 ? (
        <div className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-10 text-center space-y-3">
          <FileCode2 className="h-8 w-8 mx-auto text-[#6D4AFF]" />
          <h2 className="font-display text-base font-semibold text-[#1B2340] dark:text-white">
            No change plans staged yet
          </h2>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Create a table in Table Builder or link tables in Visual Designer to generate a preflighted SQL change plan.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <aside className="lg:col-span-4 rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] divide-y divide-[#E2E6F0] dark:divide-[#232B45] max-h-[680px] overflow-y-auto">
            {plans.map((p) => {
              const active = selectedPlan?.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedPlanId(p.id)}
                  className={`w-full p-3.5 text-left transition-colors ${
                    active ? 'bg-[#6D4AFF]/8 dark:bg-[#6D4AFF]/15' : 'hover:bg-[#F7F8FC] dark:hover:bg-[#181F38]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[#1B2340] dark:text-white truncate">
                      {p.title}
                    </span>
                    <span
                      className={`text-[11px] font-medium capitalize shrink-0 ${
                        p.status === 'succeeded'
                          ? 'text-[#16A66A]'
                          : p.status === 'failed'
                          ? 'text-[#E5484D]'
                          : p.status === 'pending_approval'
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-[#6D4AFF]'
                      }`}
                    >
                      {p.status.replace('_', ' ')}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                    {p.connectionName} · {p.environment} · Risk: {p.riskLevel}
                  </div>
                </button>
              );
            })}
          </aside>

          {selectedPlan && (
            <section className="lg:col-span-8 rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 pb-4 border-b border-[#E2E6F0] dark:border-[#232B45]">
                <div>
                  <h2 className="font-display text-lg font-bold text-[#1B2340] dark:text-white">
                    {selectedPlan.title}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Authored by {selectedPlan.createdByName} · Digest{' '}
                    <span className="font-mono">{selectedPlan.digest}</span> · Fingerprint{' '}
                    <span className="font-mono">{selectedPlan.targetFingerprint}</span>
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {selectedPlan.status !== 'succeeded' && (
                    <>
                      <button
                        type="button"
                        disabled={checkingDrift}
                        onClick={() => handleCheckDrift(selectedPlan)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs font-medium hover:bg-slate-50 dark:hover:bg-[#181F38]"
                      >
                        <GitCompare className="h-3.5 w-3.5 text-[#6D4AFF]" />
                        <span>{checkingDrift ? 'Checking Drift...' : 'Check Drift'}</span>
                      </button>
                      <button
                        type="button"
                        disabled={busyId === selectedPlan.id}
                        onClick={() => handleRevalidate(selectedPlan)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs font-medium hover:bg-slate-50 dark:hover:bg-[#181F38]"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        <span>Revalidate</span>
                      </button>
                      <button
                        type="button"
                        disabled={busyId === selectedPlan.id}
                        onClick={() => handleDiscard(selectedPlan)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs text-[#E5484D] hover:bg-red-50 dark:hover:bg-red-950/30"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>Discard</span>
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                {selectedPlan.plainExplanation}
              </div>

              {/* Schema Drift Report */}
              {activeDrift && (
                <div
                  className={`rounded-lg border p-3.5 text-xs space-y-1.5 ${
                    activeDrift.drifted
                      ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200'
                      : 'border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-200'
                  }`}
                >
                  <div className="font-semibold">
                    {activeDrift.drifted ? 'Schema Drift Detected Against Target Database' : 'Schema Baseline Matches Live Database'}
                  </div>
                  <p>{activeDrift.summary}</p>
                  {activeDrift.addedTables.length > 0 && (
                    <div className="font-mono text-[11px]">Added tables: {activeDrift.addedTables.join(', ')}</div>
                  )}
                  {activeDrift.removedTables.length > 0 && (
                    <div className="font-mono text-[11px]">Removed tables: {activeDrift.removedTables.join(', ')}</div>
                  )}
                  {activeDrift.changedTables.map((ct) => (
                    <div key={ct.fullName} className="font-mono text-[11px]">
                      Modified {ct.fullName}:{' '}
                      {[
                        ct.addedColumns.length ? `+cols(${ct.addedColumns.join(',')})` : '',
                        ct.removedColumns.length ? `-cols(${ct.removedColumns.join(',')})` : '',
                        ct.alteredColumns.length ? `~cols(${ct.alteredColumns.join(',')})` : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    </div>
                  ))}
                </div>
              )}

              {selectedPlan.preflight.warnings.map((w, idx) => (
                <div
                  key={idx}
                  className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2"
                >
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{w}</span>
                </div>
              ))}

              <div>
                <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                  Reviewed T-SQL Execution Plan
                </div>
                <div className="rounded-lg bg-[#13172B] text-slate-100 p-4 overflow-x-auto">
                  <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap">
                    {selectedPlan.sqlPreview}
                  </pre>
                </div>
              </div>

              {selectedPlan.executionSummary && (
                <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 p-3 text-xs text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>{selectedPlan.executionSummary}</span>
                </div>
              )}

              {selectedPlan.errorMessage && (
                <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-3 text-xs text-[#E5484D] flex items-center gap-2">
                  <XCircle className="h-4 w-4 shrink-0" />
                  <span>{selectedPlan.errorMessage}</span>
                </div>
              )}

              {selectedPlan.status !== 'succeeded' && workspace && (
                <div className="pt-3 border-t border-[#E2E6F0] dark:border-[#232B45] space-y-3">
                  {selectedPlan.requiresConfirmText && (
                    <div>
                      <label className="block text-xs font-medium text-[#E5484D] mb-1">
                        Type <span className="font-mono font-bold">{selectedPlan.requiresConfirmText}</span> to unlock destructive execution
                      </label>
                      <input
                        type="text"
                        value={confirmInputs[selectedPlan.id] ?? ''}
                        onChange={(e) =>
                          setConfirmInputs((p) => ({ ...p, [selectedPlan.id]: e.target.value }))
                        }
                        placeholder={selectedPlan.requiresConfirmText}
                        className="w-full sm:w-72 rounded-lg border border-red-300 dark:border-red-900 bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-1.5 text-xs font-mono"
                      />
                    </div>
                  )}

                  {(() => {
                    const approveDecision = canApproveChangePlan(
                      workspace.currentActor,
                      selectedPlan,
                      workspace.policy
                    );
                    const schemaDecision = canModifySchema(workspace.currentActor, targetConnection);

                    return (
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="text-xs text-slate-500">
                          {selectedPlan.status === 'pending_approval' && !approveDecision.allowed
                            ? approveDecision.reason
                            : !schemaDecision.allowed
                            ? schemaDecision.reason
                            : selectedPlan.approvedByName
                            ? `Approved by ${selectedPlan.approvedByName}`
                            : 'Ready for explicit confirmation.'}
                        </div>

                        <div className="flex items-center gap-2">
                          {selectedPlan.requiresApproval && selectedPlan.status === 'pending_approval' && (
                            <button
                              type="button"
                              disabled={!approveDecision.allowed || busyId === selectedPlan.id}
                              onClick={() => handleApprove(selectedPlan)}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[#6D4AFF] text-[#6D4AFF] text-xs font-medium disabled:opacity-40"
                            >
                              <ShieldCheck className="h-3.5 w-3.5" />
                              <span>Approve Plan</span>
                            </button>
                          )}

                          <button
                            type="button"
                            disabled={
                              busyId === selectedPlan.id ||
                              !schemaDecision.allowed ||
                              (selectedPlan.requiresApproval && selectedPlan.status !== 'approved')
                            }
                            onClick={() => handleExecute(selectedPlan)}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-xs font-medium disabled:opacity-40"
                          >
                            <Play className="h-3.5 w-3.5" />
                            <span>{busyId === selectedPlan.id ? 'Applying...' : 'Apply to Database'}</span>
                          </button>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
