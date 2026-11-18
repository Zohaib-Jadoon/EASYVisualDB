import React, { useEffect, useState } from 'react';
import { CreditCard, Database, MailPlus, Shield } from 'lucide-react';
import { api } from '../lib/api';
import {
  BillingCheckoutSession,
  PlanTier,
  WorkspaceInvitation,
  WorkspaceRole,
  WorkspaceSummary,
} from '../shared/types';

interface WorkspaceBillingPageProps {
  workspace: WorkspaceSummary | null;
  migrations: Array<{ id: string; name: string; appliedAt: string }>;
  billingProviderConfigured: boolean;
  billingEvents: BillingCheckoutSession[];
  onRefreshWorkspace: () => Promise<void>;
  onToast: (tone: 'success' | 'error' | 'info', title: string, detail?: string) => void;
}

const PLAN_OPTIONS: Array<{
  tier: PlanTier;
  name: string;
  price: string;
  audience: string;
  limits: string;
}> = [
  {
    tier: 'free',
    name: 'Free / Starter',
    price: '$0 / month',
    audience: 'For solo evaluation',
    limits: '1 active seat · 1 database connection · 7-day audit log',
  },
  {
    tier: 'pro',
    name: 'Pro',
    price: '$15 / user / month',
    audience: 'For individual professionals',
    limits: '1 seat · Up to 3 database connections · 30-day audit log',
  },
  {
    tier: 'team',
    name: 'Team',
    price: '$49 / workspace / month',
    audience: 'For growing engineering teams',
    limits: '3 seats included · Up to 10 connections · Change approvals · 90-day audit',
  },
  {
    tier: 'enterprise',
    name: 'Business / Enterprise',
    price: 'Custom annual quote',
    audience: 'For regulated organizations',
    limits: '25+ seats · Up to 100 connections · SAML SSO & private deployment',
  },
];

export function WorkspaceBillingPage({
  workspace,
  migrations,
  billingProviderConfigured,
  billingEvents,
  onRefreshWorkspace,
  onToast,
}: WorkspaceBillingPageProps) {
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('Designer');
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [issuedInviteToken, setIssuedInviteToken] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    api
      .listInvitations()
      .then((res) => setInvitations(res.invitations || []))
      .catch(() => setInvitations([]));
  }, [workspace?.id]);

  if (!workspace) return null;

  const isPrivileged =
    workspace.currentActor.role === 'Owner' || workspace.currentActor.role === 'Admin';
  const isOwner = workspace.currentActor.role === 'Owner';

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.createInvitation({
        name: inviteName,
        email: inviteEmail,
        role: inviteRole,
      });
      setIssuedInviteToken(res.inviteToken);
      setInviteName('');
      setInviteEmail('');
      const invRes = await api.listInvitations();
      setInvitations(invRes.invitations || []);
      await onRefreshWorkspace();
      onToast('success', 'Team invitation created', 'Share the one-time invite token so the member can register & join.');
    } catch (err) {
      onToast('error', 'Failed to create invitation', err instanceof Error ? err.message : 'Error');
    }
  };

  const handleUpdatePolicy = async (patch: Record<string, boolean>) => {
    try {
      await api.updatePolicy(patch);
      await onRefreshWorkspace();
      onToast('info', 'Policy updated', 'Workspace governance rules applied.');
    } catch (err) {
      onToast('error', 'Policy change denied', err instanceof Error ? err.message : 'Error');
    }
  };

  const handleSelectPlan = async (tier: PlanTier) => {
    try {
      await api.updatePlan(tier);
      await onRefreshWorkspace();
      onToast(
        'success',
        'Plan updated',
        'Entitlement quotas updated immediately. Customer databases are never altered on plan changes.'
      );
    } catch (err) {
      onToast('error', 'Plan change denied', err instanceof Error ? err.message : 'Only Owners can switch plans');
    }
  };

  const handleStartCheckout = async (tier: PlanTier) => {
    try {
      const res = await api.createBillingCheckout(tier);
      await onRefreshWorkspace();
      onToast('info', `Billing checkout session created (${res.checkout.provider})`, res.checkout.note);
    } catch (err) {
      onToast('error', 'Checkout failed', err instanceof Error ? err.message : 'Error');
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-[#1B2340] dark:text-white">
          Team, Security Policies & Billing
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          {workspace.organizationName} · {workspace.name} · Region: {workspace.region}
        </p>
      </div>

      {/* Team RBAC Table + Invitations */}
      <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <h2 className="font-display text-sm font-semibold text-[#1B2340] dark:text-white">
            Workspace Members & RBAC Privileges
          </h2>
          <span className="text-xs text-slate-500 tabular-nums">
            {workspace.subscription.seatsUsed} / {workspace.subscription.seatsIncluded} seat(s) included
          </span>
        </div>

        <div className="overflow-x-auto border border-[#E2E6F0] dark:border-[#232B45] rounded-lg">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#F7F8FC] dark:bg-[#181F38] border-b border-[#E2E6F0] dark:border-[#232B45] text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Member</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Schema DDL</th>
                <th className="px-3 py-2 font-medium">Data Write</th>
                <th className="px-3 py-2 font-medium">MFA</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E6F0] dark:divide-[#232B45]">
              {workspace.members.map((m) => (
                <tr key={m.id}>
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-[#1B2340] dark:text-white">{m.name}</div>
                    <div className="text-[11px] text-slate-400">{m.email}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <select
                      aria-label={`Role for ${m.name}`}
                      disabled={!isPrivileged}
                      value={m.role}
                      onChange={async (e) => {
                        try {
                          await api.updateMember(m.id, { role: e.target.value as WorkspaceRole });
                          await onRefreshWorkspace();
                        } catch (err) {
                          onToast('error', 'Failed', err instanceof Error ? err.message : 'Error');
                        }
                      }}
                      className="rounded border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2 py-1 text-xs"
                    >
                      {(['Owner', 'Admin', 'Designer', 'Data Editor', 'Viewer'] as const).map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2.5">{m.schemaWrite ? 'Allowed' : 'Blocked'}</td>
                  <td className="px-3 py-2.5">{m.dataWrite ? 'Allowed' : 'Read-Only'}</td>
                  <td className="px-3 py-2.5">
                    <button
                      type="button"
                      disabled={!isPrivileged}
                      onClick={async () => {
                        await api.updateMember(m.id, { mfaEnabled: !m.mfaEnabled });
                        await onRefreshWorkspace();
                      }}
                      className={`text-xs font-medium ${m.mfaEnabled ? 'text-[#16A66A]' : 'text-slate-400'}`}
                    >
                      {m.mfaEnabled ? 'Verified' : 'Enable MFA'}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 capitalize">{m.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {isPrivileged && (
          <form onSubmit={handleSendInvite} className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 pt-2">
            <input
              type="text"
              required
              placeholder="Full name"
              value={inviteName}
              onChange={(e) => setInviteName(e.target.value)}
              className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-1.5 text-xs"
            />
            <input
              type="email"
              required
              placeholder="Email address"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-1.5 text-xs"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as WorkspaceRole)}
              className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-1.5 text-xs"
            >
              <option value="Admin">Admin</option>
              <option value="Designer">Designer</option>
              <option value="Data Editor">Data Editor</option>
              <option value="Viewer">Viewer</option>
            </select>
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium"
            >
              <MailPlus className="h-3.5 w-3.5" />
              <span>Issue Team Invite</span>
            </button>
          </form>
        )}

        {issuedInviteToken && (
          <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs space-y-1">
            <div className="font-semibold text-amber-900 dark:text-amber-200">
              One-Time Invitation Token (Use "Accept Invite" in Sign In modal)
            </div>
            <div className="font-mono select-all text-amber-950 dark:text-amber-100">{issuedInviteToken}</div>
          </div>
        )}

        {invitations.length > 0 && (
          <div className="pt-2 border-t border-[#E2E6F0] dark:border-[#232B45] space-y-1.5">
            <div className="text-[11px] font-medium text-slate-400">Issued Workspace Invitations</div>
            {invitations.map((inv) => (
              <div key={inv.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div>
                  <span className="font-medium text-[#1B2340] dark:text-white">{inv.name}</span>{' '}
                  <span className="text-slate-500">({inv.email})</span>
                </div>
                <div className="text-slate-500 font-mono text-[11px]">
                  {inv.role} · {inv.status} · Token: {inv.tokenPreview}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Governance Policies */}
      <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-3">
        <h2 className="font-display text-sm font-semibold text-[#1B2340] dark:text-white flex items-center gap-2">
          <Shield className="h-4 w-4 text-[#6D4AFF]" />
          <span>Change Control & Governance Policies</span>
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <label className="flex items-center justify-between p-3 rounded-lg border border-[#E2E6F0] dark:border-[#232B45]">
            <span>Require approval before Production execution</span>
            <input
              type="checkbox"
              disabled={!isPrivileged}
              checked={workspace.policy.requireApprovalForProduction}
              onChange={(e) =>
                handleUpdatePolicy({ requireApprovalForProduction: e.target.checked })
              }
            />
          </label>
          <label className="flex items-center justify-between p-3 rounded-lg border border-[#E2E6F0] dark:border-[#232B45]">
            <span>Separation of duties (author cannot self-approve)</span>
            <input
              type="checkbox"
              disabled={!isPrivileged}
              checked={workspace.policy.separationOfDuties}
              onChange={(e) => handleUpdatePolicy({ separationOfDuties: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between p-3 rounded-lg border border-[#E2E6F0] dark:border-[#232B45]">
            <span>Require MFA for privileged plan approvals</span>
            <input
              type="checkbox"
              disabled={!isPrivileged}
              checked={workspace.policy.requireMfaForPrivileged}
              onChange={(e) => handleUpdatePolicy({ requireMfaForPrivileged: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between p-3 rounded-lg border border-[#E2E6F0] dark:border-[#232B45]">
            <span>AI Assistant metadata-only opt-in</span>
            <input
              type="checkbox"
              disabled={!isPrivileged}
              checked={workspace.policy.aiAssistantEnabled && workspace.policy.aiSchemaSharingConsent}
              onChange={(e) =>
                handleUpdatePolicy({
                  aiAssistantEnabled: e.target.checked,
                  aiSchemaSharingConsent: e.target.checked,
                })
              }
            />
          </label>
        </div>
      </section>

      {/* Subscription Plans & Billing Provider Integration */}
      <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h2 className="font-display text-sm font-semibold text-[#1B2340] dark:text-white flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-[#6D4AFF]" />
              <span>Commercial Plan, Entitlements & Billing Provider</span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Active usage: <span className="tabular-nums">{workspace.subscription.connectionsUsed}</span> of{' '}
              <span className="tabular-nums">{workspace.subscription.connectionsLimit}</span> connection(s) ·{' '}
              {billingProviderConfigured ? 'External Checkout Configured' : 'Local Entitlement Mode'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {PLAN_OPTIONS.map((plan) => {
            const isCurrent = workspace.subscription.tier === plan.tier;
            return (
              <div
                key={plan.tier}
                className={`rounded-xl border p-4 flex flex-col justify-between gap-4 ${
                  isCurrent
                    ? 'border-[#6D4AFF] bg-[#6D4AFF]/5 dark:bg-[#6D4AFF]/10'
                    : 'border-[#E2E6F0] dark:border-[#232B45]'
                }`}
              >
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-slate-500">{plan.audience}</div>
                  <div className="font-display text-base font-bold text-[#1B2340] dark:text-white">
                    {plan.name}
                  </div>
                  <div className="font-display text-sm font-semibold text-[#6D4AFF] tabular-nums">
                    {plan.price}
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400 pt-1 leading-relaxed">
                    {plan.limits}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <button
                    type="button"
                    disabled={isCurrent || !isOwner}
                    onClick={() => handleSelectPlan(plan.tier)}
                    className={`w-full py-2 rounded-lg text-xs font-medium transition-colors ${
                      isCurrent
                        ? 'bg-[#6D4AFF]/15 text-[#6D4AFF] cursor-default'
                        : 'bg-[#1B2340] dark:bg-[#6D4AFF] text-white hover:opacity-90 disabled:opacity-40'
                    }`}
                  >
                    {isCurrent ? 'Current Plan' : 'Apply Plan Entitlement'}
                  </button>
                  {!isCurrent && isOwner && (
                    <button
                      type="button"
                      onClick={() => handleStartCheckout(plan.tier)}
                      className="w-full py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-[11px] font-medium hover:bg-slate-50 dark:hover:bg-[#181F38]"
                    >
                      Create Checkout Session
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {billingEvents.length > 0 && (
          <div className="pt-3 border-t border-[#E2E6F0] dark:border-[#232B45] space-y-1.5">
            <div className="text-[11px] font-medium text-slate-400">Recent Billing Sessions</div>
            {billingEvents.slice(0, 4).map((ev) => (
              <div key={ev.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span>
                  Tier <strong className="capitalize">{ev.targetTier}</strong> · {ev.provider}
                </span>
                <span className="text-slate-500 font-mono text-[11px]">
                  {ev.status} · {new Date(ev.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* SaaS Control-Plane Migrations */}
      <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-3">
        <h2 className="font-display text-sm font-semibold text-[#1B2340] dark:text-white flex items-center gap-2">
          <Database className="h-4 w-4 text-[#6D4AFF]" />
          <span>Control-Plane Schema Migrations ({migrations.length} applied)</span>
        </h2>
        <div className="divide-y divide-[#E2E6F0] dark:divide-[#232B45]">
          {migrations.map((mig) => (
            <div key={mig.id} className="py-2 flex items-center justify-between text-xs">
              <span className="font-mono text-[#1B2340] dark:text-slate-200">
                {mig.id}_{mig.name}
              </span>
              <span className="font-mono text-slate-400 text-[11px] tabular-nums">
                Applied {new Date(mig.appliedAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
