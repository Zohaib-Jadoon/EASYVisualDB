import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AuditEvent,
  AuthUser,
  BillingCheckoutSession,
  ChangePlan,
  ConnectionProfile,
  DiagramNodePosition,
  PlanTier,
  SchemaSnapshot,
  SubscriptionInfo,
  WindowsAgentRecord,
  WorkspaceInvitation,
  WorkspaceMember,
  WorkspacePolicy,
  WorkspaceRole,
  WorkspaceSummary,
} from '../shared/types';
import { decryptSecret, encryptSecret, hashPassword, redactSensitiveText, verifyPassword } from './crypto';
import { MigrationRecord, runControlPlaneMigrations } from './migrations';

const DATA_DIR = process.env.VDS_DATA_DIR
  ? path.resolve(process.env.VDS_DATA_DIR)
  : path.resolve(process.cwd(), 'data');
const CONTROL_DB_PATH = path.join(DATA_DIR, 'control-plane.db');

export const PLAN_CATALOG: Record<
  PlanTier,
  Omit<SubscriptionInfo, 'connectionsUsed' | 'seatsUsed' | 'status'>
> = {
  free: {
    tier: 'free',
    name: 'Free / Starter',
    monthlyPriceUsd: 0,
    seatsIncluded: 1,
    connectionsLimit: 1,
    approvalsEnabled: false,
    auditRetentionDays: 7,
  },
  pro: {
    tier: 'pro',
    name: 'Pro',
    monthlyPriceUsd: 15,
    seatsIncluded: 1,
    connectionsLimit: 3,
    approvalsEnabled: false,
    auditRetentionDays: 30,
  },
  team: {
    tier: 'team',
    name: 'Team',
    monthlyPriceUsd: 49,
    seatsIncluded: 3,
    connectionsLimit: 10,
    approvalsEnabled: true,
    auditRetentionDays: 90,
  },
  enterprise: {
    tier: 'enterprise',
    name: 'Business / Enterprise',
    monthlyPriceUsd: null,
    seatsIncluded: 25,
    connectionsLimit: 100,
    approvalsEnabled: true,
    auditRetentionDays: 365,
  },
};

export class ControlPlaneStore {
  private migrations: MigrationRecord[] = [];
  private db: DatabaseSync;

  constructor(dbPath = CONTROL_DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
    this.ensureDefaultWorkspace();
  }

  close() {
    this.db.close();
  }

  private initSchema() {
    this.migrations = runControlPlaneMigrations(this.db);
  }

  getMigrations(): MigrationRecord[] {
    return this.migrations;
  }

  private ensureDefaultWorkspace() {
    const existing = this.db
      .prepare('SELECT id FROM workspaces WHERE id = ?')
      .get('ws_primary');
    if (existing) return;

    const defaultPolicy: WorkspacePolicy = {
      requireApprovalForProduction: true,
      separationOfDuties: true,
      requireMfaForPrivileged: false,
      aiAssistantEnabled: false,
      aiSchemaSharingConsent: false,
      maxExportRows: 1000,
    };

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspaces (id, organization_name, name, region, plan_tier, policy_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'ws_primary',
        'Visual Data Labs',
        'Primary Workspace',
        'ap-south-1 (Singapore / PK Pilot)',
        'team',
        JSON.stringify(defaultPolicy),
        now
      );

    // Seed workspace members for RBAC & separation-of-duties workflows
    const insertMember = this.db.prepare(
      `INSERT INTO members (id, workspace_id, name, email, role, schema_write, data_write, mfa_enabled, status, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertMember.run(
      'usr_owner',
      'ws_primary',
      'Zainab Jadoon',
      'zainab@visualdatastudio.io',
      'Owner',
      1,
      1,
      1,
      'active',
      now
    );
    insertMember.run(
      'usr_designer',
      'ws_primary',
      'Hamza Malik',
      'hamza@visualdatastudio.io',
      'Designer',
      1,
      1,
      0,
      'active',
      now
    );
    insertMember.run(
      'usr_viewer',
      'ws_primary',
      'Sara Ahmed',
      'sara@visualdatastudio.io',
      'Viewer',
      0,
      0,
      0,
      'active',
      now
    );

    // Also create a second isolated workspace to demonstrate & test AUTH-02 tenant isolation
    this.db
      .prepare(
        `INSERT INTO workspaces (id, organization_name, name, region, plan_tier, policy_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'ws_secondary',
        'Crescent Retail Group',
        'Staging Operations',
        'me-central-1',
        'free',
        JSON.stringify(defaultPolicy),
        now
      );
    insertMember.run(
      'usr_sec_owner',
      'ws_secondary',
      'Omar Farooq',
      'omar@crescentretail.pk',
      'Owner',
      1,
      1,
      1,
      'active',
      now
    );
  }

  getWorkspaceSummary(workspaceId: string, actorId?: string): WorkspaceSummary {
    const ws = this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(workspaceId) as Record<string, unknown> | undefined;
    if (!ws) {
      throw new Error('Workspace not found.');
    }
    const members = this.listMembers(workspaceId);
    const currentActor =
      members.find((m) => m.id === actorId) ?? members[0];
    if (!currentActor) {
      throw new Error('No active member in workspace.');
    }
    const connCountRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM connections WHERE workspace_id = ?')
      .get(workspaceId) as { cnt: number };

    const tier = (ws.plan_tier as PlanTier) || 'free';
    const planBase = PLAN_CATALOG[tier] ?? PLAN_CATALOG.free;
    const subscription: SubscriptionInfo = {
      ...planBase,
      connectionsUsed: connCountRow.cnt,
      seatsUsed: members.filter((m) => m.status === 'active').length,
      status: 'active',
    };

    return {
      id: String(ws.id),
      organizationName: String(ws.organization_name),
      name: String(ws.name),
      region: String(ws.region),
      policy: JSON.parse(String(ws.policy_json)) as WorkspacePolicy,
      subscription,
      currentActor,
      members,
    };
  }

  listWorkspaces(): Array<{ id: string; organizationName: string; name: string; planTier: PlanTier }> {
    const rows = this.db
      .prepare('SELECT id, organization_name, name, plan_tier FROM workspaces ORDER BY created_at ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      organizationName: String(r.organization_name),
      name: String(r.name),
      planTier: String(r.plan_tier) as PlanTier,
    }));
  }

  listMembers(workspaceId: string): WorkspaceMember[] {
    const rows = this.db
      .prepare('SELECT * FROM members WHERE workspace_id = ? ORDER BY joined_at ASC')
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      email: String(r.email),
      role: String(r.role) as WorkspaceRole,
      schemaWrite: Boolean(r.schema_write),
      dataWrite: Boolean(r.data_write),
      mfaEnabled: Boolean(r.mfa_enabled),
      status: String(r.status) as 'active' | 'suspended',
      joinedAt: String(r.joined_at),
    }));
  }

  addMember(
    workspaceId: string,
    input: { name: string; email: string; role: WorkspaceRole }
  ): WorkspaceMember {
    const id = `usr_${crypto.randomBytes(5).toString('hex')}`;
    const now = new Date().toISOString();
    const schemaWrite = input.role === 'Owner' || input.role === 'Admin' || input.role === 'Designer' ? 1 : 0;
    const dataWrite = input.role !== 'Viewer' ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO members (id, workspace_id, name, email, role, schema_write, data_write, mfa_enabled, status, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, workspaceId, input.name.trim(), input.email.trim(), input.role, schemaWrite, dataWrite, 0, 'active', now);

    return {
      id,
      name: input.name.trim(),
      email: input.email.trim(),
      role: input.role,
      schemaWrite: Boolean(schemaWrite),
      dataWrite: Boolean(dataWrite),
      mfaEnabled: false,
      status: 'active',
      joinedAt: now,
    };
  }

  updateMemberRole(
    workspaceId: string,
    memberId: string,
    updates: { role?: WorkspaceRole; schemaWrite?: boolean; dataWrite?: boolean; status?: 'active' | 'suspended'; mfaEnabled?: boolean }
  ): WorkspaceMember {
    const existing = this.db
      .prepare('SELECT * FROM members WHERE id = ? AND workspace_id = ?')
      .get(memberId, workspaceId) as Record<string, unknown> | undefined;
    if (!existing) throw new Error('Member not found in workspace.');

    const role = updates.role ?? (String(existing.role) as WorkspaceRole);
    const schemaWrite =
      updates.schemaWrite !== undefined
        ? updates.schemaWrite
        : role === 'Viewer' || role === 'Data Editor'
        ? false
        : Boolean(existing.schema_write);
    const dataWrite =
      updates.dataWrite !== undefined
        ? updates.dataWrite
        : role === 'Viewer'
        ? false
        : Boolean(existing.data_write);
    const status = updates.status ?? (String(existing.status) as 'active' | 'suspended');
    const mfaEnabled = updates.mfaEnabled !== undefined ? updates.mfaEnabled : Boolean(existing.mfa_enabled);

    this.db
      .prepare(
        `UPDATE members SET role = ?, schema_write = ?, data_write = ?, status = ?, mfa_enabled = ?
         WHERE id = ? AND workspace_id = ?`
      )
      .run(role, schemaWrite ? 1 : 0, dataWrite ? 1 : 0, status, mfaEnabled ? 1 : 0, memberId, workspaceId);

    return {
      id: memberId,
      name: String(existing.name),
      email: String(existing.email),
      role,
      schemaWrite,
      dataWrite,
      mfaEnabled,
      status,
      joinedAt: String(existing.joined_at),
    };
  }

  updatePolicy(workspaceId: string, partial: Partial<WorkspacePolicy>): WorkspacePolicy {
    const summary = this.getWorkspaceSummary(workspaceId);
    const next: WorkspacePolicy = { ...summary.policy, ...partial };
    this.db
      .prepare('UPDATE workspaces SET policy_json = ? WHERE id = ?')
      .run(JSON.stringify(next), workspaceId);
    return next;
  }

  updatePlanTier(workspaceId: string, tier: PlanTier): SubscriptionInfo {
    this.db.prepare('UPDATE workspaces SET plan_tier = ? WHERE id = ?').run(tier, workspaceId);
    return this.getWorkspaceSummary(workspaceId).subscription;
  }

  listAllConnections(): ConnectionProfile[] {
    const rows = this.db
      .prepare('SELECT * FROM connections ORDER BY last_checked_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapConnectionRow(r));
  }

  listConnections(workspaceId: string): ConnectionProfile[] {
    const rows = this.db
      .prepare('SELECT * FROM connections WHERE workspace_id = ? ORDER BY last_checked_at DESC')
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapConnectionRow(r));
  }

  getConnection(workspaceId: string, connectionId: string): ConnectionProfile | null {
    const row = this.db
      .prepare('SELECT * FROM connections WHERE id = ? AND workspace_id = ?')
      .get(connectionId, workspaceId) as Record<string, unknown> | undefined;
    return row ? this.mapConnectionRow(row) : null;
  }

  getConnectionSecret(workspaceId: string, connectionId: string): string {
    const row = this.db
      .prepare('SELECT encrypted_secret FROM connections WHERE id = ? AND workspace_id = ?')
      .get(connectionId, workspaceId) as { encrypted_secret: string } | undefined;
    if (!row) throw new Error('Connection not found.');
    return decryptSecret(row.encrypted_secret);
  }

  saveConnection(
    workspaceId: string,
    profile: Omit<ConnectionProfile, 'id' | 'workspaceId'>,
    rawSecret: string
  ): ConnectionProfile {
    const id = `conn_${crypto.randomBytes(6).toString('hex')}`;
    const encrypted = encryptSecret(rawSecret);
    this.db
      .prepare(
        `INSERT INTO connections (
          id, workspace_id, name, method, host, instance_name, port, database_name, auth_method,
          username, domain, encrypted_secret, encrypt, trust_cert, read_only, timeout_ms, reconnect_on_startup,
          environment, status, engine_version, last_checked_at, last_error, capabilities_json, agent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        workspaceId,
        profile.name,
        profile.method,
        profile.host,
        profile.instanceName ?? null,
        profile.port,
        profile.database,
        profile.authMethod,
        profile.username,
        profile.domain ?? null,
        encrypted,
        profile.encrypt ? 1 : 0,
        profile.trustServerCertificate ? 1 : 0,
        profile.readOnly ? 1 : 0,
        profile.timeoutMs ?? 8000,
        profile.reconnectOnStartup ? 1 : 0,
        profile.environment,
        profile.status,
        profile.engineVersion,
        profile.lastCheckedAt,
        profile.lastError ?? null,
        JSON.stringify(profile.capabilities),
        profile.agentId ?? null
      );

    return { ...profile, id, workspaceId };
  }

  updateConnection(
    workspaceId: string,
    connectionId: string,
    updates: Partial<
      Pick<
        ConnectionProfile,
        | 'readOnly'
        | 'status'
        | 'lastCheckedAt'
        | 'lastError'
        | 'name'
        | 'environment'
        | 'reconnectOnStartup'
        | 'timeoutMs'
        | 'engineVersion'
        | 'capabilities'
        | 'database'
      >
    > & {
      newSecret?: string;
    }
  ): ConnectionProfile {
    const existing = this.getConnection(workspaceId, connectionId);
    if (!existing) throw new Error('Connection not found in workspace.');

    const nextReadOnly = updates.readOnly !== undefined ? updates.readOnly : existing.readOnly;
    const nextStatus = updates.status ?? existing.status;
    const nextChecked = updates.lastCheckedAt ?? existing.lastCheckedAt;
    const nextError = updates.lastError !== undefined ? updates.lastError : existing.lastError;
    const nextName = updates.name ?? existing.name;
    const nextEnv = updates.environment ?? existing.environment;
    const nextReconnect =
      updates.reconnectOnStartup !== undefined ? updates.reconnectOnStartup : existing.reconnectOnStartup;
    const nextTimeout = updates.timeoutMs ?? existing.timeoutMs;
    const nextEngine = updates.engineVersion ?? existing.engineVersion;
    const nextCaps = updates.capabilities ?? existing.capabilities;
    const nextDb = updates.database ?? existing.database;

    this.db
      .prepare(
        `UPDATE connections SET read_only = ?, status = ?, last_checked_at = ?, last_error = ?, name = ?, environment = ?, reconnect_on_startup = ?, timeout_ms = ?, engine_version = ?, capabilities_json = ?, database_name = ?
         WHERE id = ? AND workspace_id = ?`
      )
      .run(
        nextReadOnly ? 1 : 0,
        nextStatus,
        nextChecked,
        nextError ?? null,
        nextName,
        nextEnv,
        nextReconnect ? 1 : 0,
        nextTimeout,
        nextEngine,
        JSON.stringify(nextCaps),
        nextDb,
        connectionId,
        workspaceId
      );

    if (updates.newSecret !== undefined) {
      const encrypted = encryptSecret(updates.newSecret);
      this.db
        .prepare('UPDATE connections SET encrypted_secret = ? WHERE id = ? AND workspace_id = ?')
        .run(encrypted, connectionId, workspaceId);
    }

    return this.getConnection(workspaceId, connectionId)!;
  }

  deleteConnection(workspaceId: string, connectionId: string): void {
    this.db
      .prepare('DELETE FROM connections WHERE id = ? AND workspace_id = ?')
      .run(connectionId, workspaceId);
  }

  saveSchemaSnapshot(workspaceId: string, snapshot: SchemaSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO schema_snapshots (connection_id, workspace_id, snapshot_json, fingerprint, captured_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(connection_id) DO UPDATE SET
           snapshot_json = excluded.snapshot_json,
           fingerprint = excluded.fingerprint,
           captured_at = excluded.captured_at`
      )
      .run(
        snapshot.connectionId,
        workspaceId,
        JSON.stringify(snapshot),
        snapshot.fingerprint,
        snapshot.capturedAt
      );
  }

  getSchemaSnapshot(workspaceId: string, connectionId: string): SchemaSnapshot | null {
    const row = this.db
      .prepare('SELECT snapshot_json FROM schema_snapshots WHERE connection_id = ? AND workspace_id = ?')
      .get(connectionId, workspaceId) as { snapshot_json: string } | undefined;
    return row ? (JSON.parse(row.snapshot_json) as SchemaSnapshot) : null;
  }

  listChangePlans(workspaceId: string, connectionId?: string): ChangePlan[] {
    const rows = connectionId
      ? (this.db
          .prepare('SELECT * FROM change_plans WHERE workspace_id = ? AND connection_id = ? ORDER BY created_at DESC')
          .all(workspaceId, connectionId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM change_plans WHERE workspace_id = ? ORDER BY created_at DESC')
          .all(workspaceId) as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapPlanRow(r));
  }

  getChangePlan(workspaceId: string, planId: string): ChangePlan | null {
    const row = this.db
      .prepare('SELECT * FROM change_plans WHERE id = ? AND workspace_id = ?')
      .get(planId, workspaceId) as Record<string, unknown> | undefined;
    return row ? this.mapPlanRow(row) : null;
  }

  saveChangePlan(plan: ChangePlan, baselineSnapshot?: SchemaSnapshot | null): void {
    this.db
      .prepare(
        `INSERT INTO change_plans (
          id, workspace_id, connection_id, connection_name, environment, title, plain_explanation,
          operations_json, sql_preview, risk_level, requires_confirm_text, requires_approval,
          status, target_fingerprint, digest, preflight_json, created_by_id, created_by_name,
          approved_by_id, approved_by_name, created_at, executed_at, execution_summary, error_message, baseline_snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        plan.id,
        plan.workspaceId,
        plan.connectionId,
        plan.connectionName,
        plan.environment,
        plan.title,
        plan.plainExplanation,
        JSON.stringify(plan.operations),
        plan.sqlPreview,
        plan.riskLevel,
        plan.requiresConfirmText ?? null,
        plan.requiresApproval ? 1 : 0,
        plan.status,
        plan.targetFingerprint,
        plan.digest,
        JSON.stringify(plan.preflight),
        plan.createdById,
        plan.createdByName,
        plan.approvedById ?? null,
        plan.approvedByName ?? null,
        plan.createdAt,
        plan.executedAt ?? null,
        plan.executionSummary ?? null,
        plan.errorMessage ?? null,
        baselineSnapshot ? JSON.stringify(baselineSnapshot) : null
      );
  }

  getPlanBaselineSnapshot(workspaceId: string, planId: string): SchemaSnapshot | null {
    const row = this.db
      .prepare('SELECT baseline_snapshot_json FROM change_plans WHERE id = ? AND workspace_id = ?')
      .get(planId, workspaceId) as { baseline_snapshot_json: string | null } | undefined;
    return row?.baseline_snapshot_json ? (JSON.parse(row.baseline_snapshot_json) as SchemaSnapshot) : null;
  }

  revalidateChangePlan(
    workspaceId: string,
    planId: string,
    updates: Pick<
      ChangePlan,
      'sqlPreview' | 'plainExplanation' | 'riskLevel' | 'requiresConfirmText' | 'targetFingerprint' | 'digest' | 'preflight' | 'status'
    >,
    baselineSnapshot: SchemaSnapshot
  ): ChangePlan {
    this.db
      .prepare(
        `UPDATE change_plans SET sql_preview = ?, plain_explanation = ?, risk_level = ?, requires_confirm_text = ?, target_fingerprint = ?, digest = ?, preflight_json = ?, status = ?, approved_by_id = NULL, approved_by_name = NULL, baseline_snapshot_json = ?
         WHERE id = ? AND workspace_id = ?`
      )
      .run(
        updates.sqlPreview,
        updates.plainExplanation,
        updates.riskLevel,
        updates.requiresConfirmText ?? null,
        updates.targetFingerprint,
        updates.digest,
        JSON.stringify(updates.preflight),
        updates.status,
        JSON.stringify(baselineSnapshot),
        planId,
        workspaceId
      );
    return this.getChangePlan(workspaceId, planId)!;
  }

  deleteChangePlan(workspaceId: string, planId: string): boolean {
    const res = this.db
      .prepare('DELETE FROM change_plans WHERE id = ? AND workspace_id = ?')
      .run(planId, workspaceId);
    return Number(res.changes) > 0;
  }

  updateChangePlanStatus(
    workspaceId: string,
    planId: string,
    updates: Partial<
      Pick<
        ChangePlan,
        'status' | 'approvedById' | 'approvedByName' | 'executedAt' | 'executionSummary' | 'errorMessage'
      >
    >
  ): ChangePlan {
    const existing = this.getChangePlan(workspaceId, planId);
    if (!existing) throw new Error('Change plan not found.');
    const next = { ...existing, ...updates };
    this.db
      .prepare(
        `UPDATE change_plans SET status = ?, approved_by_id = ?, approved_by_name = ?,
         executed_at = ?, execution_summary = ?, error_message = ?
         WHERE id = ? AND workspace_id = ?`
      )
      .run(
        next.status,
        next.approvedById ?? null,
        next.approvedByName ?? null,
        next.executedAt ?? null,
        next.executionSummary ?? null,
        next.errorMessage ?? null,
        planId,
        workspaceId
      );
    return next;
  }

  appendAuditEvent(event: Omit<AuditEvent, 'id' | 'timestamp' | 'correlationId'> & { correlationId?: string }): AuditEvent {
    const full: AuditEvent = {
      id: `aud_${crypto.randomBytes(6).toString('hex')}`,
      correlationId: event.correlationId ?? `cor_${crypto.randomBytes(5).toString('hex')}`,
      timestamp: new Date().toISOString(),
      ...event,
      detail: redactSensitiveText(event.detail),
    };
    this.db
      .prepare(
        `INSERT INTO audit_events (
          id, workspace_id, correlation_id, actor_id, actor_name, actor_role,
          action, resource_type, target, database_name, status, detail, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        full.id,
        full.workspaceId,
        full.correlationId,
        full.actorId,
        full.actorName,
        full.actorRole,
        full.action,
        full.resourceType,
        full.target,
        full.databaseName ?? null,
        full.status,
        full.detail,
        full.timestamp
      );
    return full;
  }

  listAuditEvents(workspaceId: string, limit = 100): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_events WHERE workspace_id = ? ORDER BY timestamp DESC LIMIT ?')
      .all(workspaceId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      correlationId: String(r.correlation_id),
      actorId: String(r.actor_id),
      actorName: String(r.actor_name),
      actorRole: String(r.actor_role) as WorkspaceRole,
      action: String(r.action),
      resourceType: String(r.resource_type) as AuditEvent['resourceType'],
      target: String(r.target),
      databaseName: r.database_name ? String(r.database_name) : null,
      status: String(r.status) as AuditEvent['status'],
      detail: String(r.detail),
      timestamp: String(r.timestamp),
    }));
  }

  getDiagramLayout(workspaceId: string, connectionId: string): DiagramNodePosition[] {
    const row = this.db
      .prepare('SELECT positions_json FROM diagram_layouts WHERE connection_id = ? AND workspace_id = ?')
      .get(connectionId, workspaceId) as { positions_json: string } | undefined;
    return row ? (JSON.parse(row.positions_json) as DiagramNodePosition[]) : [];
  }

  saveDiagramLayout(workspaceId: string, connectionId: string, positions: DiagramNodePosition[]): void {
    this.db
      .prepare(
        `INSERT INTO diagram_layouts (connection_id, workspace_id, positions_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(connection_id) DO UPDATE SET positions_json = excluded.positions_json, updated_at = excluded.updated_at`
      )
      .run(connectionId, workspaceId, JSON.stringify(positions), new Date().toISOString());
  }

  listSavedQueries(workspaceId: string, connectionId: string) {
    return this.db
      .prepare('SELECT * FROM saved_queries WHERE workspace_id = ? AND connection_id = ? ORDER BY created_at DESC')
      .all(workspaceId, connectionId) as Array<{
      id: string;
      name: string;
      sql_text: string;
      created_by: string;
      created_at: string;
    }>;
  }

  saveQuery(workspaceId: string, connectionId: string, name: string, sqlText: string, createdBy: string) {
    const id = `qry_${crypto.randomBytes(5).toString('hex')}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO saved_queries (id, workspace_id, connection_id, name, sql_text, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, workspaceId, connectionId, name.trim(), sqlText, createdBy, now);
    return { id, name: name.trim(), sql_text: sqlText, created_by: createdBy, created_at: now };
  }

  recordQueryHistory(
    workspaceId: string,
    connectionId: string,
    actorName: string,
    sqlText: string,
    rowCount: number,
    durationMs: number,
    status: 'succeeded' | 'failed'
  ) {
    const id = `qh_${crypto.randomBytes(5).toString('hex')}`;
    this.db
      .prepare(
        'INSERT INTO query_history (id, workspace_id, connection_id, actor_name, sql_text, row_count, duration_ms, status, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, workspaceId, connectionId, actorName, sqlText, rowCount, durationMs, status, new Date().toISOString());
  }

  listQueryHistory(workspaceId: string, connectionId: string) {
    return this.db
      .prepare('SELECT * FROM query_history WHERE workspace_id = ? AND connection_id = ? ORDER BY executed_at DESC LIMIT 25')
      .all(workspaceId, connectionId);
  }

  listAgents(workspaceId: string): WindowsAgentRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM windows_agents WHERE workspace_id = ? ORDER BY created_at DESC')
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapAgentRow(r));
  }

  private mapAgentRow(r: Record<string, unknown>): WindowsAgentRecord {
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      name: String(r.name),
      hostname: String(r.hostname),
      version: String(r.version),
      status: String(r.status) as WindowsAgentRecord['status'],
      lastHeartbeatAt: r.last_heartbeat_at ? String(r.last_heartbeat_at) : null,
      pairingTokenPreview: String(r.pairing_token_preview),
      createdAt: String(r.created_at),
      osInfo: r.os_info ? String(r.os_info) : null,
      discoveredInstancesCount: r.discovered_count !== undefined && r.discovered_count !== null ? Number(r.discovered_count) : 0,
    };
  }

  createAgentPairing(workspaceId: string, name: string, hostname: string): {
    agent: WindowsAgentRecord;
    oneTimeToken: string;
  } {
    const id = `agt_${crypto.randomBytes(5).toString('hex')}`;
    const oneTimeToken = `vds_pair_${crypto.randomBytes(16).toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(oneTimeToken).digest('hex');
    const preview = `${oneTimeToken.slice(0, 12)}...${oneTimeToken.slice(-4)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO windows_agents (id, workspace_id, name, hostname, version, status, last_heartbeat_at, pairing_token_hash, pairing_token_preview, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, workspaceId, name.trim(), hostname.trim(), '1.0.0-win-x64', 'pending_approval', null, tokenHash, preview, now);

    return {
      agent: {
        id,
        workspaceId,
        name: name.trim(),
        hostname: hostname.trim(),
        version: '1.0.0-win-x64',
        status: 'pending_approval',
        lastHeartbeatAt: null,
        pairingTokenPreview: preview,
        createdAt: now,
      },
      oneTimeToken,
    };
  }

  authenticateAgentToken(token: string): WindowsAgentRecord | null {
    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
    const row = this.db
      .prepare('SELECT * FROM windows_agents WHERE pairing_token_hash = ?')
      .get(tokenHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapAgentRow(row);
  }

  updateAgentTelemetry(
    agentId: string,
    updates: {
      status?: WindowsAgentRecord['status'];
      hostname?: string;
      version?: string;
      osInfo?: string;
      discoveredCount?: number;
      lastHeartbeatAt?: string;
    }
  ): WindowsAgentRecord | null {
    const row = this.db
      .prepare('SELECT * FROM windows_agents WHERE id = ?')
      .get(agentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db
      .prepare(
        `UPDATE windows_agents SET status = ?, hostname = ?, version = ?, os_info = ?, discovered_count = ?, last_heartbeat_at = ? WHERE id = ?`
      )
      .run(
        updates.status ?? String(row.status),
        updates.hostname ?? String(row.hostname),
        updates.version ?? String(row.version),
        updates.osInfo ?? (row.os_info ? String(row.os_info) : null),
        updates.discoveredCount ?? Number(row.discovered_count ?? 0),
        updates.lastHeartbeatAt ?? (row.last_heartbeat_at ? String(row.last_heartbeat_at) : null),
        agentId
      );
    const updated = this.db.prepare('SELECT * FROM windows_agents WHERE id = ?').get(agentId) as Record<string, unknown>;
    return this.mapAgentRow(updated);
  }

  updateAgentStatus(workspaceId: string, agentId: string, status: WindowsAgentRecord['status']) {
    this.db
      .prepare('UPDATE windows_agents SET status = ? WHERE id = ? AND workspace_id = ?')
      .run(status, agentId, workspaceId);
  }

  // Authentication & Sessions
  registerUser(input: { name: string; email: string; password: string; organizationName?: string }): {
    user: AuthUser;
    sessionId: string;
    workspaceId: string;
  } {
    const cleanEmail = input.email.trim().toLowerCase();
    const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
    if (existing) {
      throw new Error('An account with that email already exists.');
    }

    const userId = `usr_${crypto.randomBytes(5).toString('hex')}`;
    const workspaceId = `ws_${crypto.randomBytes(5).toString('hex')}`;
    const now = new Date().toISOString();
    const passHash = hashPassword(input.password);
    const defaultPolicy: WorkspacePolicy = {
      requireApprovalForProduction: true,
      separationOfDuties: true,
      requireMfaForPrivileged: false,
      aiAssistantEnabled: false,
      aiSchemaSharingConsent: false,
      maxExportRows: 1000,
    };

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, input.name.trim(), cleanEmail, passHash, now);

      this.db
        .prepare(
          'INSERT INTO workspaces (id, organization_name, name, region, plan_tier, policy_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          workspaceId,
          input.organizationName?.trim() || `${input.name.trim()} Org`,
          'Primary Workspace',
          'local-win11',
          'free',
          JSON.stringify(defaultPolicy),
          now
        );

      this.db
        .prepare(
          'INSERT INTO members (id, workspace_id, name, email, role, schema_write, data_write, mfa_enabled, status, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(userId, workspaceId, input.name.trim(), cleanEmail, 'Owner', 1, 1, 0, 'active', now);

      const sessionId = `ses_${crypto.randomBytes(16).toString('hex')}`;
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      this.db
        .prepare('INSERT INTO auth_sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(sessionId, userId, now, expiresAt);

      this.db.exec('COMMIT;');
      return {
        user: { id: userId, name: input.name.trim(), email: cleanEmail, createdAt: now },
        sessionId,
        workspaceId,
      };
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  loginUser(email: string, password: string): { user: AuthUser; sessionId: string; defaultWorkspaceId: string } {
    const cleanEmail = email.trim().toLowerCase();
    const row = this.db
      .prepare('SELECT id, name, email, password_hash, created_at FROM users WHERE email = ?')
      .get(cleanEmail) as Record<string, unknown> | undefined;
    if (!row || !verifyPassword(password, String(row.password_hash))) {
      throw new Error('Invalid email or password.');
    }

    const userId = String(row.id);
    const sessionId = `ses_${crypto.randomBytes(16).toString('hex')}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db
      .prepare('INSERT INTO auth_sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, userId, now, expiresAt);

    const memberWs = this.db
      .prepare('SELECT workspace_id FROM members WHERE id = ? OR email = ? LIMIT 1')
      .get(userId, cleanEmail) as { workspace_id: string } | undefined;

    return {
      user: {
        id: userId,
        name: String(row.name),
        email: String(row.email),
        createdAt: String(row.created_at),
      },
      sessionId,
      defaultWorkspaceId: memberWs?.workspace_id || 'ws_primary',
    };
  }

  getUserBySessionId(sessionId: string): AuthUser | null {
    const row = this.db
      .prepare(
        `SELECT u.id, u.name, u.email, u.created_at, s.expires_at
         FROM auth_sessions s
         INNER JOIN users u ON s.user_id = u.id
         WHERE s.id = ?`
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (Date.parse(String(row.expires_at)) < Date.now()) {
      this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sessionId);
      return null;
    }
    return {
      id: String(row.id),
      name: String(row.name),
      email: String(row.email),
      createdAt: String(row.created_at),
    };
  }

  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sessionId);
  }

  getMemberForUserInWorkspace(workspaceId: string, user: AuthUser): WorkspaceMember | null {
    const row = this.db
      .prepare('SELECT * FROM members WHERE workspace_id = ? AND (id = ? OR LOWER(email) = LOWER(?))')
      .get(workspaceId, user.id, user.email) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      email: String(row.email),
      role: String(row.role) as WorkspaceRole,
      schemaWrite: Boolean(row.schema_write),
      dataWrite: Boolean(row.data_write),
      mfaEnabled: Boolean(row.mfa_enabled),
      status: String(row.status) as 'active' | 'suspended',
      joinedAt: String(row.joined_at),
    };
  }

  listWorkspacesForUser(user: AuthUser): Array<{ id: string; organizationName: string; name: string; planTier: PlanTier }> {
    const rows = this.db
      .prepare(
        `SELECT w.id, w.organization_name, w.name, w.plan_tier
         FROM workspaces w
         INNER JOIN members m ON m.workspace_id = w.id
         WHERE m.id = ? OR LOWER(m.email) = LOWER(?)
         ORDER BY w.created_at ASC`
      )
      .all(user.id, user.email) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      organizationName: String(r.organization_name),
      name: String(r.name),
      planTier: String(r.plan_tier) as PlanTier,
    }));
  }

  // Invitations
  listInvitations(workspaceId: string): WorkspaceInvitation[] {
    const rows = this.db
      .prepare('SELECT * FROM workspace_invitations WHERE workspace_id = ? ORDER BY created_at DESC')
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      email: String(r.email),
      name: String(r.name),
      role: String(r.role) as WorkspaceRole,
      tokenPreview: String(r.token_preview),
      status: String(r.status) as WorkspaceInvitation['status'],
      invitedByName: String(r.invited_by_name),
      createdAt: String(r.created_at),
      expiresAt: String(r.expires_at),
    }));
  }

  createInvitation(
    workspaceId: string,
    input: { name: string; email: string; role: WorkspaceRole; invitedByName: string }
  ): { invitation: WorkspaceInvitation; inviteToken: string } {
    const id = `inv_${crypto.randomBytes(5).toString('hex')}`;
    const inviteToken = `vds_inv_${crypto.randomBytes(14).toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
    const preview = `${inviteToken.slice(0, 11)}...${inviteToken.slice(-4)}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    this.db
      .prepare(
        `INSERT INTO workspace_invitations (id, workspace_id, email, name, role, token_hash, token_preview, status, invited_by_name, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        workspaceId,
        input.email.trim().toLowerCase(),
        input.name.trim(),
        input.role,
        tokenHash,
        preview,
        'pending',
        input.invitedByName,
        now,
        expiresAt
      );

    return {
      invitation: {
        id,
        workspaceId,
        email: input.email.trim().toLowerCase(),
        name: input.name.trim(),
        role: input.role,
        tokenPreview: preview,
        status: 'pending',
        invitedByName: input.invitedByName,
        createdAt: now,
        expiresAt,
      },
      inviteToken,
    };
  }

  acceptInvitation(inviteToken: string, password: string): { member: WorkspaceMember; user: AuthUser; sessionId: string; workspaceId: string } {
    const tokenHash = crypto.createHash('sha256').update(inviteToken.trim()).digest('hex');
    const inv = this.db
      .prepare('SELECT * FROM workspace_invitations WHERE token_hash = ? AND status = ?')
      .get(tokenHash, 'pending') as Record<string, unknown> | undefined;
    if (!inv) throw new Error('Invitation token is invalid or already used.');
    if (Date.parse(String(inv.expires_at)) < Date.now()) {
      throw new Error('Invitation token has expired.');
    }

    const email = String(inv.email).toLowerCase();
    const name = String(inv.name);
    const workspaceId = String(inv.workspace_id);
    const role = String(inv.role) as WorkspaceRole;
    const now = new Date().toISOString();

    let userRow = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as Record<string, unknown> | undefined;
    let userId: string;
    if (!userRow) {
      userId = `usr_${crypto.randomBytes(5).toString('hex')}`;
      this.db
        .prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, name, email, hashPassword(password), now);
    } else {
      userId = String(userRow.id);
    }

    const schemaWrite = role === 'Owner' || role === 'Admin' || role === 'Designer' ? 1 : 0;
    const dataWrite = role !== 'Viewer' ? 1 : 0;

    const existingMember = this.db
      .prepare('SELECT id FROM members WHERE workspace_id = ? AND LOWER(email) = LOWER(?)')
      .get(workspaceId, email) as { id: string } | undefined;

    if (!existingMember) {
      this.db
        .prepare(
          'INSERT INTO members (id, workspace_id, name, email, role, schema_write, data_write, mfa_enabled, status, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(userId, workspaceId, name, email, role, schemaWrite, dataWrite, 0, 'active', now);
    }

    this.db.prepare('UPDATE workspace_invitations SET status = ? WHERE id = ?').run('accepted', String(inv.id));

    const sessionId = `ses_${crypto.randomBytes(16).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db
      .prepare('INSERT INTO auth_sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, userId, now, expiresAt);

    return {
      member: {
        id: existingMember?.id || userId,
        name,
        email,
        role,
        schemaWrite: Boolean(schemaWrite),
        dataWrite: Boolean(dataWrite),
        mfaEnabled: false,
        status: 'active',
        joinedAt: now,
      },
      user: { id: userId, name, email, createdAt: now },
      sessionId,
      workspaceId,
    };
  }

  recordBillingEvent(session: BillingCheckoutSession) {
    this.db
      .prepare(
        'INSERT INTO billing_events (id, workspace_id, provider, target_tier, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(session.id, session.workspaceId, session.provider, session.targetTier, session.status, session.note, session.createdAt);
  }

  listBillingEvents(workspaceId: string): BillingCheckoutSession[] {
    const rows = this.db
      .prepare('SELECT * FROM billing_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      provider: String(r.provider) as BillingCheckoutSession['provider'],
      targetTier: String(r.target_tier) as PlanTier,
      status: String(r.status) as BillingCheckoutSession['status'],
      checkoutUrl: null,
      note: String(r.note),
      createdAt: String(r.created_at),
    }));
  }

  private mapConnectionRow(r: Record<string, unknown>): ConnectionProfile {
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      name: String(r.name),
      method: String(r.method) as ConnectionProfile['method'],
      host: String(r.host),
      instanceName: r.instance_name ? String(r.instance_name) : null,
      port: Number(r.port),
      database: String(r.database_name),
      authMethod: String(r.auth_method) as ConnectionProfile['authMethod'],
      username: String(r.username),
      domain: r.domain ? String(r.domain) : null,
      encrypt: Boolean(r.encrypt),
      trustServerCertificate: Boolean(r.trust_cert),
      readOnly: Boolean(r.read_only),
      timeoutMs: r.timeout_ms ? Number(r.timeout_ms) : 8000,
      reconnectOnStartup: r.reconnect_on_startup !== undefined ? Boolean(r.reconnect_on_startup) : true,
      environment: String(r.environment) as ConnectionProfile['environment'],
      status: String(r.status) as ConnectionProfile['status'],
      engineVersion: String(r.engine_version),
      lastCheckedAt: String(r.last_checked_at),
      lastError: r.last_error ? String(r.last_error) : null,
      capabilities: JSON.parse(String(r.capabilities_json)),
      agentId: r.agent_id ? String(r.agent_id) : null,
    };
  }

  private mapPlanRow(r: Record<string, unknown>): ChangePlan {
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      connectionId: String(r.connection_id),
      connectionName: String(r.connection_name),
      environment: String(r.environment) as ChangePlan['environment'],
      title: String(r.title),
      plainExplanation: String(r.plain_explanation),
      operations: JSON.parse(String(r.operations_json)),
      sqlPreview: String(r.sql_preview),
      riskLevel: String(r.risk_level) as ChangePlan['riskLevel'],
      requiresConfirmText: r.requires_confirm_text ? String(r.requires_confirm_text) : null,
      requiresApproval: Boolean(r.requires_approval),
      status: String(r.status) as ChangePlan['status'],
      targetFingerprint: String(r.target_fingerprint),
      digest: String(r.digest),
      preflight: JSON.parse(String(r.preflight_json)),
      createdById: String(r.created_by_id),
      createdByName: String(r.created_by_name),
      approvedById: r.approved_by_id ? String(r.approved_by_id) : null,
      approvedByName: r.approved_by_name ? String(r.approved_by_name) : null,
      createdAt: String(r.created_at),
      executedAt: r.executed_at ? String(r.executed_at) : null,
      executionSummary: r.execution_summary ? String(r.execution_summary) : null,
      errorMessage: r.error_message ? String(r.error_message) : null,
    };
  }
}

export const controlPlane = new ControlPlaneStore();
