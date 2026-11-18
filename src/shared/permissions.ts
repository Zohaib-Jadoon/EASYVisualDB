import {
  ChangePlan,
  ConnectionProfile,
  SubscriptionInfo,
  WorkspaceMember,
  WorkspacePolicy,
} from './types';

export interface AuthorizationDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Enforces stricter-wins authorization across SaaS role, member flags,
 * connection read-only mode, and SQL Server discovered permissions.
 */
export function canModifySchema(
  actor: WorkspaceMember,
  connection: ConnectionProfile | null
): AuthorizationDecision {
  if (actor.status !== 'active') {
    return { allowed: false, reason: 'Your workspace membership is suspended.' };
  }
  if (actor.role === 'Viewer' || actor.role === 'Data Editor' || !actor.schemaWrite) {
    return {
      allowed: false,
      reason: `Role "${actor.role}" does not have schema-write privileges.`,
    };
  }
  if (!connection) {
    return { allowed: false, reason: 'Connect or select a database first.' };
  }
  if (connection.readOnly) {
    return {
      allowed: false,
      reason: 'This connection is in Read-Only (Explorer) mode. Explicitly enable Write Access in Connections to apply schema changes.',
    };
  }
  if (!connection.capabilities.canModifySchema) {
    return {
      allowed: false,
      reason: 'The SQL Server login lacks ALTER/CREATE permissions on this database.',
    };
  }
  return { allowed: true };
}

export function canModifyData(
  actor: WorkspaceMember,
  connection: ConnectionProfile | null
): AuthorizationDecision {
  if (actor.status !== 'active') {
    return { allowed: false, reason: 'Your workspace membership is suspended.' };
  }
  if (actor.role === 'Viewer' || !actor.dataWrite) {
    return {
      allowed: false,
      reason: `Role "${actor.role}" is read-only for table records.`,
    };
  }
  if (!connection) {
    return { allowed: false, reason: 'Connect or select a database first.' };
  }
  if (connection.readOnly) {
    return {
      allowed: false,
      reason: 'This connection is in Read-Only (Explorer) mode. Switch to Read-Write in Connections to edit rows.',
    };
  }
  if (!connection.capabilities.canWriteData) {
    return {
      allowed: false,
      reason: 'The SQL Server login lacks INSERT/UPDATE/DELETE permissions.',
    };
  }
  return { allowed: true };
}

export function canApproveChangePlan(
  actor: WorkspaceMember,
  plan: ChangePlan,
  policy: WorkspacePolicy
): AuthorizationDecision {
  if (actor.status !== 'active') {
    return { allowed: false, reason: 'Suspended members cannot approve changes.' };
  }
  if (actor.role !== 'Owner' && actor.role !== 'Admin') {
    return {
      allowed: false,
      reason: 'Only a Workspace Owner or Admin can approve protected change plans.',
    };
  }
  if (policy.requireMfaForPrivileged && !actor.mfaEnabled) {
    return {
      allowed: false,
      reason: 'Multi-factor authentication (MFA) is required before approving schema changes.',
    };
  }
  if (
    policy.separationOfDuties &&
    plan.environment === 'production' &&
    plan.createdById === actor.id
  ) {
    return {
      allowed: false,
      reason: 'Separation of duties is active: the author of a production change plan cannot self-approve it.',
    };
  }
  return { allowed: true };
}

export function canExecuteChangePlan(
  actor: WorkspaceMember,
  plan: ChangePlan,
  connection: ConnectionProfile,
  currentSnapshotFingerprint: string,
  confirmTextInput?: string
): AuthorizationDecision {
  const schemaAuth = canModifySchema(actor, connection);
  if (!schemaAuth.allowed) return schemaAuth;

  if (!plan.preflight.passed) {
    return {
      allowed: false,
      reason: 'Preflight validation failed. Resolve blocking issues before executing.',
    };
  }

  if (plan.requiresApproval && plan.status !== 'approved') {
    return {
      allowed: false,
      reason: 'This plan targets Production or requires review approval before execution.',
    };
  }

  if (plan.targetFingerprint !== currentSnapshotFingerprint) {
    return {
      allowed: false,
      reason: 'Schema snapshot changed since this plan was compiled (stale plan). Refresh metadata and re-validate before applying.',
    };
  }

  if (plan.requiresConfirmText) {
    if ((confirmTextInput ?? '').trim() !== plan.requiresConfirmText) {
      return {
        allowed: false,
        reason: `Type "${plan.requiresConfirmText}" exactly to confirm this high-risk operation.`,
      };
    }
  }

  return { allowed: true };
}

export function checkConnectionEntitlement(subscription: SubscriptionInfo): AuthorizationDecision {
  if (subscription.connectionsUsed >= subscription.connectionsLimit) {
    return {
      allowed: false,
      reason: `Your ${subscription.name} plan allows up to ${subscription.connectionsLimit} active connection(s). Upgrade in Workspace & Billing to add more.`,
    };
  }
  return { allowed: true };
}
