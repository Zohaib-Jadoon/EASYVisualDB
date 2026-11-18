import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canApproveChangePlan,
  canExecuteChangePlan,
  canModifyData,
  canModifySchema,
  checkConnectionEntitlement,
} from './permissions';
import { ChangePlan, ConnectionProfile, SubscriptionInfo, WorkspaceMember, WorkspacePolicy } from './types';

const baseConnection: ConnectionProfile = {
  id: 'conn_1',
  workspaceId: 'ws_1',
  name: 'Prod SQL',
  method: 'direct_tls',
  host: 'sql.example.com',
  port: 1433,
  database: 'Operations',
  authMethod: 'sql_auth',
  username: 'vds_app',
  encrypt: true,
  trustServerCertificate: false,
  readOnly: false,
  environment: 'production',
  status: 'connected',
  engineVersion: 'SQL Server 2022',
  lastCheckedAt: new Date().toISOString(),
  capabilities: {
    canReadMetadata: true,
    canReadData: true,
    canWriteData: true,
    canModifySchema: true,
  },
};

const ownerActor: WorkspaceMember = {
  id: 'u_owner',
  name: 'Amina Tariq',
  email: 'amina@example.com',
  role: 'Owner',
  schemaWrite: true,
  dataWrite: true,
  mfaEnabled: true,
  status: 'active',
  joinedAt: '2026-01-01T00:00:00Z',
};

const viewerActor: WorkspaceMember = {
  id: 'u_viewer',
  name: 'Bilal Khan',
  email: 'bilal@example.com',
  role: 'Viewer',
  schemaWrite: false,
  dataWrite: false,
  mfaEnabled: false,
  status: 'active',
  joinedAt: '2026-01-01T00:00:00Z',
};

const policy: WorkspacePolicy = {
  requireApprovalForProduction: true,
  separationOfDuties: true,
  requireMfaForPrivileged: true,
  aiAssistantEnabled: false,
  aiSchemaSharingConsent: false,
  maxExportRows: 1000,
};

test('Viewer cannot modify schema or data even if connection allows writes', () => {
  assert.equal(canModifySchema(viewerActor, baseConnection).allowed, false);
  assert.equal(canModifyData(viewerActor, baseConnection).allowed, false);
});

test('Read-only connection blocks schema and data writes even for Owner', () => {
  const roConn = { ...baseConnection, readOnly: true };
  assert.equal(canModifySchema(ownerActor, roConn).allowed, false);
  assert.equal(canModifyData(ownerActor, roConn).allowed, false);
});

test('Author cannot self-approve a production change plan when separationOfDuties is enabled', () => {
  const plan: ChangePlan = {
    id: 'plan_1',
    workspaceId: 'ws_1',
    connectionId: 'conn_1',
    connectionName: 'Prod SQL',
    environment: 'production',
    title: 'Add Projects table',
    plainExplanation: 'Creates Projects table',
    operations: [],
    sqlPreview: 'CREATE TABLE ...',
    riskLevel: 'low',
    requiresApproval: true,
    status: 'pending_approval',
    targetFingerprint: 'fp_abc',
    digest: 'dig_123',
    preflight: {
      passed: true,
      checks: [],
      warnings: [],
      requiredPermissions: [],
      estimatedImpact: '1 table',
    },
    createdById: 'u_owner',
    createdByName: 'Amina Tariq',
    createdAt: new Date().toISOString(),
  };

  const selfApprove = canApproveChangePlan(ownerActor, plan, policy);
  assert.equal(selfApprove.allowed, false);

  const secondAdmin: WorkspaceMember = { ...ownerActor, id: 'u_admin', role: 'Admin' };
  assert.equal(canApproveChangePlan(secondAdmin, plan, policy).allowed, true);
});

test('Execution rejects stale fingerprint or missing confirm text', () => {
  const approvedPlan: ChangePlan = {
    id: 'plan_2',
    workspaceId: 'ws_1',
    connectionId: 'conn_1',
    connectionName: 'Prod SQL',
    environment: 'production',
    title: 'Drop Notes column',
    plainExplanation: 'Drops Notes',
    operations: [],
    sqlPreview: 'ALTER TABLE ...',
    riskLevel: 'destructive',
    requiresConfirmText: 'DROP Notes',
    requiresApproval: true,
    status: 'approved',
    targetFingerprint: 'fp_v1',
    digest: 'dig_456',
    preflight: {
      passed: true,
      checks: [],
      warnings: [],
      requiredPermissions: [],
      estimatedImpact: '1 column',
    },
    createdById: 'u_designer',
    createdByName: 'Zara',
    approvedById: 'u_owner',
    approvedByName: 'Amina',
    createdAt: new Date().toISOString(),
  };

  // Stale fingerprint rejected
  assert.equal(
    canExecuteChangePlan(ownerActor, approvedPlan, baseConnection, 'fp_v2', 'DROP Notes').allowed,
    false
  );
  // Missing confirm text rejected
  assert.equal(
    canExecuteChangePlan(ownerActor, approvedPlan, baseConnection, 'fp_v1', 'wrong').allowed,
    false
  );
  // Valid fingerprint + confirm text allowed
  assert.equal(
    canExecuteChangePlan(ownerActor, approvedPlan, baseConnection, 'fp_v1', 'DROP Notes').allowed,
    true
  );
});

test('Entitlement service rejects over-limit connections', () => {
  const freeSub: SubscriptionInfo = {
    tier: 'free',
    name: 'Free / Starter',
    monthlyPriceUsd: 0,
    seatsIncluded: 1,
    seatsUsed: 1,
    connectionsLimit: 1,
    connectionsUsed: 1,
    approvalsEnabled: false,
    auditRetentionDays: 7,
    status: 'active',
  };
  assert.equal(checkConnectionEntitlement(freeSub).allowed, false);
});
