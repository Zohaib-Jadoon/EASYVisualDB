import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AuditEvent,
  ChangePlan,
  ConnectionProfile,
  DiagramNodePosition,
  PlanTier,
  SchemaSnapshot,
  SubscriptionInfo,
  WindowsAgentRecord,
  WorkspaceMember,
  WorkspacePolicy,
  WorkspaceRole,
  WorkspaceSummary,
} from '../shared/types';
import { decryptSecret, encryptSecret, redactSensitiveText } from './crypto';

const DATA_DIR = path.resolve(process.cwd(), 'data');
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

class ControlPlaneStore {
  private db: DatabaseSync;

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.db = new DatabaseSync(CONTROL_DB_PATH);
    this.initSchema();
    this.ensureDefaultWorkspace();
  }

  private initSchema() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        organization_name TEXT NOT NULL,
        name TEXT NOT NULL,
        region TEXT NOT NULL,
        plan_tier TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        schema_write INTEGER NOT NULL,
        data_write INTEGER NOT NULL,
        mfa_enabled INTEGER NOT NULL,
        status TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        method TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        database_name TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        username TEXT NOT NULL,
        encrypted_secret TEXT NOT NULL,
        encrypt INTEGER NOT NULL,
        trust_cert INTEGER NOT NULL,
        read_only INTEGER NOT NULL,
        environment TEXT NOT NULL,
        status TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        last_checked_at TEXT NOT NULL,
        last_error TEXT,
        capabilities_json TEXT NOT NULL,
        agent_id TEXT,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS schema_snapshots (
        connection_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS change_plans (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        connection_name TEXT NOT NULL,
        environment TEXT NOT NULL,
        title TEXT NOT NULL,
        plain_explanation TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        sql_preview TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        requires_confirm_text TEXT,
        requires_approval INTEGER NOT NULL,
        status TEXT NOT NULL,
        target_fingerprint TEXT NOT NULL,
        digest TEXT NOT NULL,
        preflight_json TEXT NOT NULL,
        created_by_id TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        approved_by_id TEXT,
        approved_by_name TEXT,
        created_at TEXT NOT NULL,
        executed_at TEXT,
        execution_summary TEXT,
        error_message TEXT,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        target TEXT NOT NULL,
        database_name TEXT,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS diagram_layouts (
        connection_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        positions_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS saved_queries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sql_text TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS query_history (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        sql_text TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        executed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS windows_agents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        hostname TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL,
        last_heartbeat_at TEXT,
        pairing_token_hash TEXT NOT NULL,
        pairing_token_preview TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
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
          id, workspace_id, name, method, host, port, database_name, auth_method,
          username, encrypted_secret, encrypt, trust_cert, read_only, environment,
          status, engine_version, last_checked_at, last_error, capabilities_json, agent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        workspaceId,
        profile.name,
        profile.method,
        profile.host,
        profile.port,
        profile.database,
        profile.authMethod,
        profile.username,
        encrypted,
        profile.encrypt ? 1 : 0,
        profile.trustServerCertificate ? 1 : 0,
        profile.readOnly ? 1 : 0,
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
    updates: Partial<Pick<ConnectionProfile, 'readOnly' | 'status' | 'lastCheckedAt' | 'lastError' | 'name' | 'environment'>> & {
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

    this.db
      .prepare(
        `UPDATE connections SET read_only = ?, status = ?, last_checked_at = ?, last_error = ?, name = ?, environment = ?
         WHERE id = ? AND workspace_id = ?`
      )
      .run(
        nextReadOnly ? 1 : 0,
        nextStatus,
        nextChecked,
        nextError ?? null,
        nextName,
        nextEnv,
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

  saveChangePlan(plan: ChangePlan): void {
    this.db
      .prepare(
        `INSERT INTO change_plans (
          id, workspace_id, connection_id, connection_name, environment, title, plain_explanation,
          operations_json, sql_preview, risk_level, requires_confirm_text, requires_approval,
          status, target_fingerprint, digest, preflight_json, created_by_id, created_by_name,
          approved_by_id, approved_by_name, created_at, executed_at, execution_summary, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        plan.errorMessage ?? null
      );
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
    return rows.map((r) => ({
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      name: String(r.name),
      hostname: String(r.hostname),
      version: String(r.version),
      status: String(r.status) as WindowsAgentRecord['status'],
      lastHeartbeatAt: r.last_heartbeat_at ? String(r.last_heartbeat_at) : null,
      pairingTokenPreview: String(r.pairing_token_preview),
      createdAt: String(r.created_at),
    }));
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

  updateAgentStatus(workspaceId: string, agentId: string, status: WindowsAgentRecord['status']) {
    this.db
      .prepare('UPDATE windows_agents SET status = ? WHERE id = ? AND workspace_id = ?')
      .run(status, agentId, workspaceId);
  }

  private mapConnectionRow(r: Record<string, unknown>): ConnectionProfile {
    return {
      id: String(r.id),
      workspaceId: String(r.workspace_id),
      name: String(r.name),
      method: String(r.method) as ConnectionProfile['method'],
      host: String(r.host),
      port: Number(r.port),
      database: String(r.database_name),
      authMethod: String(r.auth_method) as ConnectionProfile['authMethod'],
      username: String(r.username),
      encrypt: Boolean(r.encrypt),
      trustServerCertificate: Boolean(r.trust_cert),
      readOnly: Boolean(r.read_only),
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
