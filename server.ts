import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { NextFunction, Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { z } from 'zod';
import {
  canApproveChangePlan,
  canExecuteChangePlan,
  canModifyData,
  canModifySchema,
  checkConnectionEntitlement,
} from './src/shared/permissions';
import {
  compileOperationsPlan,
  compileVisualQuery,
  computeDeterministicDigest,
  quoteTsqlIdentifier,
  validateIdentifier,
} from './src/shared/sqlCompiler';
import {
  ChangePlan,
  ConnectionProfile,
  PlanTier,
  SchemaOperation,
  VisualQuerySpec,
  WorkspaceRole,
} from './src/shared/types';
import {
  generateReadOnlySqlWithAi,
  generateSchemaDraftWithAi,
  isAiProviderConfigured,
} from './src/server/aiAssistant';
import { controlPlane } from './src/server/controlPlane';
import { redactSensitiveText } from './src/server/crypto';
import {
  applyMssqlOperations,
  browseMssqlRows,
  diagnoseMssqlConnection,
  executeMssqlQuery,
  introspectMssql,
} from './src/server/mssqlConnector';
import { sandboxDb } from './src/server/sandboxDb';

function getTenantContext(req: Request): { workspaceId: string; actorId: string } {
  const workspaceId = String(req.header('x-workspace-id') || 'ws_primary');
  const actorId = String(req.header('x-actor-id') || '');
  return { workspaceId, actorId };
}

function getTenant(res: Response): { workspaceId: string; actorId: string } {
  return {
    workspaceId: String(res.locals.workspaceId),
    actorId: String(res.locals.actorId),
  };
}

function tenantMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const { workspaceId, actorId } = getTenantContext(req);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    res.locals.workspaceId = summary.id;
    res.locals.actorId = summary.currentActor.id;
    next();
  } catch (err) {
    res.status(403).json({
      error: err instanceof Error ? err.message : 'Workspace access denied.',
    });
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'visual-database-studio', timestamp: new Date().toISOString() });
  });

  // Workspaces list
  app.get('/api/workspaces', (_req, res) => {
    res.json({ workspaces: controlPlane.listWorkspaces() });
  });

  // All subsequent /api routes require valid tenant context
  app.use('/api', tenantMiddleware);

  app.get('/api/workspace', (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    res.json({
      workspace: summary,
      aiProviderConfigured: isAiProviderConfigured(),
    });
  });

  app.patch('/api/workspace/policy', (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    if (summary.currentActor.role !== 'Owner' && summary.currentActor.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Owners and Admins can modify workspace security policies.' });
    }
    const nextPolicy = controlPlane.updatePolicy(workspaceId, req.body ?? {});
    controlPlane.appendAuditEvent({
      workspaceId,
      actorId: summary.currentActor.id,
      actorName: summary.currentActor.name,
      actorRole: summary.currentActor.role,
      action: 'workspace.policy.updated',
      resourceType: 'policy',
      target: summary.name,
      status: 'succeeded',
      detail: `Updated workspace security & AI governance settings.`,
    });
    res.json({ policy: nextPolicy });
  });

  app.patch('/api/workspace/plan', (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    if (summary.currentActor.role !== 'Owner') {
      return res.status(403).json({ error: 'Only the Workspace Owner can change subscription tiers.' });
    }
    const tier = z.enum(['free', 'pro', 'team', 'enterprise']).parse(req.body?.tier) as PlanTier;
    const subscription = controlPlane.updatePlanTier(workspaceId, tier);
    controlPlane.appendAuditEvent({
      workspaceId,
      actorId: summary.currentActor.id,
      actorName: summary.currentActor.name,
      actorRole: summary.currentActor.role,
      action: 'billing.plan.changed',
      resourceType: 'billing',
      target: subscription.name,
      status: 'succeeded',
      detail: `Switched workspace plan to ${subscription.name} (${subscription.connectionsLimit} connections max).`,
    });
    res.json({ subscription });
  });

  app.post('/api/workspace/members', (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    if (summary.currentActor.role !== 'Owner' && summary.currentActor.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Owners and Admins can invite members.' });
    }
    const schema = z.object({
      name: z.string().min(2).max(80),
      email: z.string().email(),
      role: z.enum(['Owner', 'Admin', 'Designer', 'Data Editor', 'Viewer']),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid member details.' });
    }
    const member = controlPlane.addMember(workspaceId, {
      name: parsed.data.name,
      email: parsed.data.email,
      role: parsed.data.role as WorkspaceRole,
    });
    controlPlane.appendAuditEvent({
      workspaceId,
      actorId: summary.currentActor.id,
      actorName: summary.currentActor.name,
      actorRole: summary.currentActor.role,
      action: 'workspace.member.added',
      resourceType: 'policy',
      target: member.email,
      status: 'succeeded',
      detail: `Added ${member.name} with role ${member.role}.`,
    });
    res.status(201).json({ member });
  });

  app.patch('/api/workspace/members/:memberId', (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    if (summary.currentActor.role !== 'Owner' && summary.currentActor.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Owners and Admins can update member roles.' });
    }
    try {
      const updated = controlPlane.updateMemberRole(workspaceId, req.params.memberId, req.body ?? {});
      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'workspace.member.updated',
        resourceType: 'policy',
        target: updated.email,
        status: 'succeeded',
        detail: `Updated ${updated.name}: role=${updated.role}, schemaWrite=${updated.schemaWrite}, dataWrite=${updated.dataWrite}, status=${updated.status}.`,
      });
      res.json({ member: updated });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Member not found.' });
    }
  });

  // Connections
  app.get('/api/connections', (req, res) => {
    const { workspaceId } = getTenant(res);
    res.json({ connections: controlPlane.listConnections(workspaceId) });
  });

  app.post('/api/connections/test', async (req, res) => {
    const schema = z.object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535).default(1433),
      database: z.string().min(1),
      username: z.string().min(1),
      password: z.string().min(1),
      encrypt: z.boolean().default(true),
      trustServerCertificate: z.boolean().default(false),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid connection parameters.' });
    }
    const result = await diagnoseMssqlConnection(parsed.data);
    res.json(result);
  });

  app.post('/api/connections', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const entitlement = checkConnectionEntitlement(summary.subscription);
    if (!entitlement.allowed) {
      return res.status(403).json({ error: entitlement.reason });
    }

    const schema = z.object({
      name: z.string().min(2).max(80),
      method: z.enum(['direct_tls', 'azure_sql', 'windows_agent']),
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535).default(1433),
      database: z.string().min(1),
      authMethod: z.enum(['sql_auth', 'entra_id', 'windows_integrated']).default('sql_auth'),
      username: z.string().min(1),
      password: z.string().min(1),
      encrypt: z.boolean().default(true),
      trustServerCertificate: z.boolean().default(false),
      environment: z.enum(['development', 'staging', 'production']).default('development'),
      readOnly: z.boolean().default(true),
      agentId: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid connection payload.' });
    }

    const diag = await diagnoseMssqlConnection({
      host: parsed.data.host,
      port: parsed.data.port,
      database: parsed.data.database,
      username: parsed.data.username,
      password: parsed.data.password,
      encrypt: parsed.data.encrypt,
      trustServerCertificate: parsed.data.trustServerCertificate,
    });

    if (!diag.ok) {
      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'connection.create.failed',
        resourceType: 'connection',
        target: parsed.data.name,
        databaseName: parsed.data.database,
        status: 'failed',
        detail: diag.steps.find((s) => s.status === 'failed')?.detail || 'Connection diagnostic failed.',
      });
      return res.status(400).json({
        error: 'Connection verification failed. Review diagnostic steps before saving.',
        diagnostics: diag,
      });
    }

    const saved = controlPlane.saveConnection(
      workspaceId,
      {
        name: parsed.data.name,
        method: parsed.data.method,
        host: parsed.data.host,
        port: parsed.data.port,
        database: parsed.data.database,
        authMethod: parsed.data.authMethod,
        username: parsed.data.username,
        encrypt: parsed.data.encrypt,
        trustServerCertificate: parsed.data.trustServerCertificate,
        readOnly: true, // Always default to read-only (CONN-04)
        environment: parsed.data.environment,
        status: 'connected',
        engineVersion: diag.engineVersion,
        lastCheckedAt: new Date().toISOString(),
        lastError: null,
        capabilities: diag.capabilities,
        agentId: parsed.data.agentId ?? null,
      },
      parsed.data.password
    );

    try {
      const snapshot = await introspectMssql(saved, parsed.data.password);
      controlPlane.saveSchemaSnapshot(workspaceId, snapshot);
    } catch {
      // Snapshot will refresh on demand
    }

    controlPlane.appendAuditEvent({
      workspaceId,
      actorId: summary.currentActor.id,
      actorName: summary.currentActor.name,
      actorRole: summary.currentActor.role,
      action: 'connection.created',
      resourceType: 'connection',
      target: saved.name,
      databaseName: saved.database,
      status: 'succeeded',
      detail: `Connected ${saved.method} endpoint in Read-Only (Explorer) mode.`,
    });

    res.status(201).json({ connection: saved, diagnostics: diag });
  });

  // Explicit Interactive Sample Sandbox provisioning (never loaded silently as fake live customer data)
  app.post('/api/connections/sample-sandbox', (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const existing = controlPlane
      .listConnections(workspaceId)
      .find((c) => c.method === 'local_sandbox');

    if (existing) {
      const snap = sandboxDb.introspect(existing.id);
      controlPlane.saveSchemaSnapshot(workspaceId, snap);
      return res.json({ connection: existing, snapshot: snap });
    }

    const entitlement = checkConnectionEntitlement(summary.subscription);
    if (!entitlement.allowed) {
      return res.status(403).json({ error: entitlement.reason });
    }

    sandboxDb.ensureSeeded();
    const saved = controlPlane.saveConnection(
      workspaceId,
      {
        name: 'NorthwindOps Sample Sandbox',
        method: 'local_sandbox',
        host: 'local-sandbox-engine',
        port: 1433,
        database: 'NorthwindOps_Sample',
        authMethod: 'sandbox_local',
        username: 'sandbox_explorer',
        encrypt: true,
        trustServerCertificate: true,
        readOnly: true, // Still follows CONN-04 read-only default!
        environment: 'sandbox',
        status: 'connected',
        engineVersion: 'Local SQL Sandbox (SQL Server 2022 T-SQL Mode)',
        lastCheckedAt: new Date().toISOString(),
        lastError: null,
        capabilities: {
          canReadMetadata: true,
          canReadData: true,
          canWriteData: true,
          canModifySchema: true,
        },
        agentId: null,
      },
      'local-sandbox-no-secret'
    );

    const snapshot = sandboxDb.introspect(saved.id);
    controlPlane.saveSchemaSnapshot(workspaceId, snapshot);

    controlPlane.appendAuditEvent({
      workspaceId,
      actorId: summary.currentActor.id,
      actorName: summary.currentActor.name,
      actorRole: summary.currentActor.role,
      action: 'connection.sandbox.mounted',
      resourceType: 'connection',
      target: saved.name,
      databaseName: saved.database,
      status: 'succeeded',
      detail: 'Mounted interactive sample relational database in Read-Only (Explorer) mode.',
    });

    res.status(201).json({ connection: saved, snapshot });
  });

  app.patch('/api/connections/:connectionId', (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found in this workspace.' });

    if (
      req.body?.readOnly === false &&
      summary.currentActor.role !== 'Owner' &&
      summary.currentActor.role !== 'Admin' &&
      summary.currentActor.role !== 'Designer'
    ) {
      return res.status(403).json({
        error: `Role "${summary.currentActor.role}" cannot unlock Write Access on a connection.`,
      });
    }

    const updated = controlPlane.updateConnection(workspaceId, conn.id, {
      readOnly: typeof req.body?.readOnly === 'boolean' ? req.body.readOnly : undefined,
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      environment: req.body?.environment,
      newSecret: typeof req.body?.newPassword === 'string' && req.body.newPassword ? req.body.newPassword : undefined,
    });

    controlPlane.appendAuditEvent({
      workspaceId,
      actorId: summary.currentActor.id,
      actorName: summary.currentActor.name,
      actorRole: summary.currentActor.role,
      action: req.body?.newPassword ? 'connection.secret.rotated' : 'connection.updated',
      resourceType: 'connection',
      target: updated.name,
      databaseName: updated.database,
      status: 'succeeded',
      detail: `Access mode: ${updated.readOnly ? 'Read-Only' : 'Read-Write'}, Environment: ${updated.environment}.`,
    });

    res.json({ connection: updated });
  });

  app.delete('/api/connections/:connectionId', (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    if (summary.currentActor.role !== 'Owner' && summary.currentActor.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Owners and Admins can remove connections.' });
    }
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    controlPlane.deleteConnection(workspaceId, conn.id);
    controlPlane.appendAuditEvent({
      workspaceId,
      actorId: summary.currentActor.id,
      actorName: summary.currentActor.name,
      actorRole: summary.currentActor.role,
      action: 'connection.deleted',
      resourceType: 'connection',
      target: conn.name,
      databaseName: conn.database,
      status: 'succeeded',
      detail: 'Disconnected and purged encrypted secret reference from control plane (customer database untouched).',
    });
    res.json({ deleted: true });
  });

  // Schema discovery & refresh
  async function getOrRefreshSnapshot(workspaceId: string, conn: ConnectionProfile, forceRefresh = false) {
    if (!forceRefresh) {
      const cached = controlPlane.getSchemaSnapshot(workspaceId, conn.id);
      if (cached) return cached;
    }
    const snapshot =
      conn.method === 'local_sandbox'
        ? sandboxDb.introspect(conn.id)
        : await introspectMssql(conn, controlPlane.getConnectionSecret(workspaceId, conn.id));
    controlPlane.saveSchemaSnapshot(workspaceId, snapshot);
    return snapshot;
  }

  app.get('/api/connections/:connectionId/schema', async (req, res) => {
    const { workspaceId } = getTenant(res);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found in this workspace.' });
    try {
      const snapshot = await getOrRefreshSnapshot(workspaceId, conn, false);
      res.json({ snapshot });
    } catch (err) {
      res.status(502).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Schema introspection failed.') });
    }
  });

  app.post('/api/connections/:connectionId/schema/refresh', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });
    try {
      const snapshot = await getOrRefreshSnapshot(workspaceId, conn, true);
      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'schema.refreshed',
        resourceType: 'connection',
        target: conn.name,
        databaseName: conn.database,
        status: 'succeeded',
        detail: `Discovered ${snapshot.tables.length} tables/views (fingerprint ${snapshot.fingerprint}).`,
      });
      res.json({ snapshot });
    } catch (err) {
      res.status(502).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Refresh failed.') });
    }
  });

  // Diagram layouts
  app.get('/api/connections/:connectionId/diagram-layout', (req, res) => {
    const { workspaceId } = getTenant(res);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });
    res.json({ positions: controlPlane.getDiagramLayout(workspaceId, conn.id) });
  });

  app.put('/api/connections/:connectionId/diagram-layout', (req, res) => {
    const { workspaceId } = getTenant(res);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });
    const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
    controlPlane.saveDiagramLayout(workspaceId, conn.id, positions);
    res.json({ saved: true });
  });

  // Records Grid CRUD (DATA-01..DATA-05)
  app.get('/api/connections/:connectionId/records', async (req, res) => {
    const { workspaceId } = getTenant(res);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    const schemaName = String(req.query.schema || 'dbo');
    const tableName = String(req.query.table || '');
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize || 50)));
    const sortColumn = req.query.sortColumn ? String(req.query.sortColumn) : undefined;
    const sortDir = req.query.sortDir === 'DESC' ? 'DESC' : 'ASC';
    const search = req.query.search ? String(req.query.search) : undefined;

    try {
      const snapshot = await getOrRefreshSnapshot(workspaceId, conn, false);
      const table = snapshot.tables.find(
        (t) => t.schemaName === schemaName && t.tableName === tableName
      );
      if (!table) return res.status(404).json({ error: `Table ${schemaName}.${tableName} not found.` });

      const columns = table.columns.map((c) => c.name);
      const data =
        conn.method === 'local_sandbox'
          ? sandboxDb.browseRows({
              schemaName,
              tableName,
              page,
              pageSize,
              sortColumn,
              sortDir,
              search,
              columns,
            })
          : await browseMssqlRows(conn, controlPlane.getConnectionSecret(workspaceId, conn.id), {
              schemaName,
              tableName,
              page,
              pageSize,
              sortColumn,
              sortDir,
              search,
              columns,
            });

      res.json({ ...data, page, pageSize, table });
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Failed to load records.') });
    }
  });

  app.post('/api/connections/:connectionId/records', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    const auth = canModifyData(summary.currentActor, conn);
    if (!auth.allowed) {
      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'record.insert.denied',
        resourceType: 'record',
        target: `${req.body?.schemaName}.${req.body?.tableName}`,
        databaseName: conn.database,
        status: 'denied',
        detail: auth.reason || 'Insufficient write privilege.',
      });
      return res.status(403).json({ error: auth.reason });
    }

    const { schemaName, tableName, values } = req.body ?? {};
    try {
      const snapshot = await getOrRefreshSnapshot(workspaceId, conn, false);
      const table = snapshot.tables.find((t) => t.schemaName === schemaName && t.tableName === tableName);
      if (!table) return res.status(404).json({ error: 'Table not found.' });

      if (conn.method === 'local_sandbox') {
        sandboxDb.insertRow(schemaName, tableName, values ?? {});
      } else {
        const keys = Object.keys(values ?? {});
        const colsSql = keys.map(quoteTsqlIdentifier).join(', ');
        const paramRefs = keys.map((_k, i) => `@p${i}`).join(', ');
        const params: Record<string, unknown> = {};
        keys.forEach((k, i) => {
          params[`p${i}`] = values[k];
        });
        await executeMssqlQuery(
          conn,
          controlPlane.getConnectionSecret(workspaceId, conn.id),
          `INSERT INTO ${quoteTsqlIdentifier(schemaName)}.${quoteTsqlIdentifier(tableName)} (${colsSql}) VALUES (${paramRefs});`,
          params,
          true
        );
      }

      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'record.inserted',
        resourceType: 'record',
        target: `${schemaName}.${tableName}`,
        databaseName: conn.database,
        status: 'succeeded',
        detail: `Inserted 1 record into ${schemaName}.${tableName} (values redacted).`,
      });
      res.status(201).json({ inserted: true });
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Insert failed.') });
    }
  });

  app.patch('/api/connections/:connectionId/records', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    const auth = canModifyData(summary.currentActor, conn);
    if (!auth.allowed) {
      return res.status(403).json({ error: auth.reason });
    }

    const { schemaName, tableName, pkValues, updates, originalValues } = req.body ?? {};
    try {
      const snapshot = await getOrRefreshSnapshot(workspaceId, conn, false);
      const table = snapshot.tables.find((t) => t.schemaName === schemaName && t.tableName === tableName);
      if (!table) return res.status(404).json({ error: 'Table not found.' });
      if (!table.hasStablePrimaryKey) {
        return res.status(400).json({
          error: 'This table has no stable Primary Key. Row editing is disabled to prevent unintended multi-row changes.',
        });
      }

      if (conn.method === 'local_sandbox') {
        const resUpdate = sandboxDb.updateRowWithConcurrency({
          schemaName,
          tableName,
          pkValues,
          updates,
          originalValues,
        });
        if (resUpdate.updatedCount === 0) {
          return res.status(409).json({
            error: 'Concurrency conflict: this record was modified or deleted by another session. Refresh the grid before retrying.',
          });
        }
      } else {
        const updateKeys = Object.keys(updates ?? {});
        const pkKeys = Object.keys(pkValues ?? {});
        const params: Record<string, unknown> = {};
        let idx = 0;
        const setParts = updateKeys.map((k) => {
          const pname = `u${idx++}`;
          params[pname] = updates[k];
          return `${quoteTsqlIdentifier(k)} = @${pname}`;
        });
        const whereParts = pkKeys.map((k) => {
          const pname = `pk${idx++}`;
          params[pname] = pkValues[k];
          return `${quoteTsqlIdentifier(k)} = @${pname}`;
        });
        for (const k of updateKeys) {
          const orig = originalValues?.[k];
          if (orig === null || orig === undefined) {
            whereParts.push(`${quoteTsqlIdentifier(k)} IS NULL`);
          } else {
            const pname = `ov${idx++}`;
            params[pname] = orig;
            whereParts.push(`${quoteTsqlIdentifier(k)} = @${pname}`);
          }
        }
        const qRes = await executeMssqlQuery(
          conn,
          controlPlane.getConnectionSecret(workspaceId, conn.id),
          `UPDATE ${quoteTsqlIdentifier(schemaName)}.${quoteTsqlIdentifier(tableName)} SET ${setParts.join(', ')} WHERE ${whereParts.join(' AND ')};`,
          params,
          true
        );
        if (qRes.rowCount === 0) {
          return res.status(409).json({
            error: 'Concurrency conflict: record values changed on SQL Server. Refresh before applying edits.',
          });
        }
      }

      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'record.updated',
        resourceType: 'record',
        target: `${schemaName}.${tableName}`,
        databaseName: conn.database,
        status: 'succeeded',
        detail: `Updated fields [${Object.keys(updates ?? {}).join(', ')}] for PK ${JSON.stringify(pkValues)} (values redacted).`,
      });
      res.json({ updated: true });
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Update failed.') });
    }
  });

  app.delete('/api/connections/:connectionId/records', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    const auth = canModifyData(summary.currentActor, conn);
    if (!auth.allowed) return res.status(403).json({ error: auth.reason });

    const { schemaName, tableName, pkColumn, pkValues } = req.body ?? {};
    if (!Array.isArray(pkValues) || pkValues.length === 0) {
      return res.status(400).json({ error: 'Specify at least one primary key value to delete.' });
    }

    try {
      const snapshot = await getOrRefreshSnapshot(workspaceId, conn, false);
      const table = snapshot.tables.find((t) => t.schemaName === schemaName && t.tableName === tableName);
      if (!table || !table.hasStablePrimaryKey) {
        return res.status(400).json({ error: 'Controlled deletes require a table with a stable Primary Key.' });
      }

      let deletedCount = 0;
      if (conn.method === 'local_sandbox') {
        deletedCount = sandboxDb.deleteRowsByPk(schemaName, tableName, pkColumn, pkValues).deletedCount;
      } else {
        const params: Record<string, unknown> = {};
        const placeholders = pkValues.map((v: unknown, i: number) => {
          params[`d${i}`] = v;
          return `@d${i}`;
        });
        const qRes = await executeMssqlQuery(
          conn,
          controlPlane.getConnectionSecret(workspaceId, conn.id),
          `DELETE FROM ${quoteTsqlIdentifier(schemaName)}.${quoteTsqlIdentifier(tableName)} WHERE ${quoteTsqlIdentifier(pkColumn)} IN (${placeholders.join(', ')});`,
          params,
          true
        );
        deletedCount = qRes.rowCount;
      }

      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'record.deleted',
        resourceType: 'record',
        target: `${schemaName}.${tableName}`,
        databaseName: conn.database,
        status: 'succeeded',
        detail: `Deleted ${deletedCount} record(s) via PK ${pkColumn} (${pkValues.slice(0, 5).join(', ')}).`,
      });
      res.json({ deletedCount });
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Delete failed.') });
    }
  });

  // CSV Import with server-side validation
  app.post('/api/connections/:connectionId/import-csv', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    const auth = canModifyData(summary.currentActor, conn);
    if (!auth.allowed) return res.status(403).json({ error: auth.reason });

    const { schemaName, tableName, rows } = req.body ?? {};
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 500) {
      return res.status(400).json({ error: 'Provide between 1 and 500 rows per import batch.' });
    }

    let committed = 0;
    const errors: Array<{ rowIndex: number; error: string }> = [];

    for (let i = 0; i < rows.length; i += 1) {
      try {
        if (conn.method === 'local_sandbox') {
          sandboxDb.insertRow(schemaName, tableName, rows[i]);
        } else {
          const keys = Object.keys(rows[i]);
          const colsSql = keys.map(quoteTsqlIdentifier).join(', ');
          const paramRefs = keys.map((_k, idx) => `@p${idx}`).join(', ');
          const params: Record<string, unknown> = {};
          keys.forEach((k, idx) => {
            params[`p${idx}`] = rows[i][k];
          });
          await executeMssqlQuery(
            conn,
            controlPlane.getConnectionSecret(workspaceId, conn.id),
            `INSERT INTO ${quoteTsqlIdentifier(schemaName)}.${quoteTsqlIdentifier(tableName)} (${colsSql}) VALUES (${paramRefs});`,
            params,
            true
          );
        }
        committed += 1;
      } catch (err) {
        errors.push({ rowIndex: i + 1, error: err instanceof Error ? err.message : 'Row rejected' });
      }
    }

    controlPlane.appendAuditEvent({
      workspaceId,
      actorId: summary.currentActor.id,
      actorName: summary.currentActor.name,
      actorRole: summary.currentActor.role,
      action: 'record.csv_imported',
      resourceType: 'record',
      target: `${schemaName}.${tableName}`,
      databaseName: conn.database,
      status: committed > 0 ? 'succeeded' : 'failed',
      detail: `CSV import: ${committed} committed, ${errors.length} skipped/rejected.`,
    });

    res.json({ committed, skipped: errors.length, errors: errors.slice(0, 20) });
  });

  // Visual Query Builder & SQL Editor
  app.post('/api/connections/:connectionId/query/visual', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    try {
      const spec = req.body as VisualQuerySpec;
      const compiled = compileVisualQuery(
        spec,
        conn.method === 'local_sandbox' ? 'sqlite' : 'tsql'
      );
      const result =
        conn.method === 'local_sandbox'
          ? sandboxDb.executeQuery(compiled.sql, compiled.orderedParams, false)
          : await executeMssqlQuery(
              conn,
              controlPlane.getConnectionSecret(workspaceId, conn.id),
              compiled.sql,
              compiled.params,
              false
            );

      const previewSql = compileVisualQuery(spec, 'tsql').sql;
      controlPlane.recordQueryHistory(
        workspaceId,
        conn.id,
        summary.currentActor.name,
        previewSql,
        result.rowCount,
        result.durationMs,
        'succeeded'
      );
      res.json({ result: { ...result, sqlExecuted: previewSql } });
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Visual query failed.') });
    }
  });

  app.post('/api/connections/:connectionId/query/sql', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    const sqlText = String(req.body?.sql || '');
    const allowMutations = canModifyData(summary.currentActor, conn).allowed;

    try {
      const result =
        conn.method === 'local_sandbox'
          ? sandboxDb.executeQuery(sqlText, [], allowMutations)
          : await executeMssqlQuery(
              conn,
              controlPlane.getConnectionSecret(workspaceId, conn.id),
              sqlText,
              {},
              allowMutations
            );

      controlPlane.recordQueryHistory(
        workspaceId,
        conn.id,
        summary.currentActor.name,
        sqlText,
        result.rowCount,
        result.durationMs,
        'succeeded'
      );

      if (result.statementType === 'MUTATION') {
        controlPlane.appendAuditEvent({
          workspaceId,
          actorId: summary.currentActor.id,
          actorName: summary.currentActor.name,
          actorRole: summary.currentActor.role,
          action: 'query.mutation_executed',
          resourceType: 'query',
          target: conn.name,
          databaseName: conn.database,
          status: 'succeeded',
          detail: `Executed SQL statement affecting ${result.rowCount} row(s).`,
        });
      }

      res.json({ result });
    } catch (err) {
      controlPlane.recordQueryHistory(
        workspaceId,
        conn.id,
        summary.currentActor.name,
        sqlText,
        0,
        0,
        'failed'
      );
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Query execution failed.') });
    }
  });

  app.get('/api/connections/:connectionId/queries', (req, res) => {
    const { workspaceId } = getTenant(res);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });
    res.json({
      saved: controlPlane.listSavedQueries(workspaceId, conn.id),
      history: controlPlane.listQueryHistory(workspaceId, conn.id),
    });
  });

  app.post('/api/connections/:connectionId/queries', (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });
    const { name, sqlText } = req.body ?? {};
    if (!name || !sqlText) return res.status(400).json({ error: 'Query name and SQL are required.' });
    const saved = controlPlane.saveQuery(workspaceId, conn.id, name, sqlText, summary.currentActor.name);
    res.status(201).json({ query: saved });
  });

  // Change Plans (Draft -> Validate -> Preview -> Approve -> Execute -> Verify -> Audit)
  app.get('/api/plans', (req, res) => {
    const { workspaceId } = getTenant(res);
    const connectionId = req.query.connectionId ? String(req.query.connectionId) : undefined;
    res.json({ plans: controlPlane.listChangePlans(workspaceId, connectionId) });
  });

  app.post('/api/plans', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const { connectionId, title, operations } = req.body ?? {};
    const conn = controlPlane.getConnection(workspaceId, String(connectionId || ''));
    if (!conn) return res.status(404).json({ error: 'Target connection not found.' });

    if (summary.currentActor.role === 'Viewer' || summary.currentActor.role === 'Data Editor') {
      return res.status(403).json({
        error: `Role "${summary.currentActor.role}" cannot stage schema change plans.`,
      });
    }

    try {
      const snapshot = await getOrRefreshSnapshot(workspaceId, conn, false);
      const ops = operations as SchemaOperation[];
      const compiled = compileOperationsPlan(ops, snapshot);
      const digest = await computeDeterministicDigest(
        JSON.stringify({ ops, sql: compiled.tsql, fp: snapshot.fingerprint })
      );

      const requiresApproval =
        conn.environment === 'production' && summary.policy.requireApprovalForProduction;

      const plan: ChangePlan = {
        id: `pln_${crypto.randomBytes(6).toString('hex')}`,
        workspaceId,
        connectionId: conn.id,
        connectionName: conn.name,
        environment: conn.environment,
        title: String(title || 'Schema Change Plan'),
        plainExplanation: compiled.plainExplanation,
        operations: ops,
        sqlPreview: compiled.tsql,
        riskLevel: compiled.riskLevel,
        requiresConfirmText: compiled.requiresConfirmText,
        requiresApproval,
        status: !compiled.preflight.passed
          ? 'draft'
          : requiresApproval
          ? 'pending_approval'
          : 'validated',
        targetFingerprint: snapshot.fingerprint,
        digest,
        preflight: compiled.preflight,
        createdById: summary.currentActor.id,
        createdByName: summary.currentActor.name,
        createdAt: new Date().toISOString(),
      };

      controlPlane.saveChangePlan(plan);
      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'plan.created',
        resourceType: 'schema_plan',
        target: plan.title,
        databaseName: conn.database,
        status: 'succeeded',
        detail: `Compiled ${ops.length} operation(s), risk=${plan.riskLevel}, status=${plan.status}.`,
      });

      res.status(201).json({ plan });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to compile change plan.' });
    }
  });

  app.post('/api/plans/:planId/approve', (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const plan = controlPlane.getChangePlan(workspaceId, req.params.planId);
    if (!plan) return res.status(404).json({ error: 'Change plan not found.' });

    const auth = canApproveChangePlan(summary.currentActor, plan, summary.policy);
    if (!auth.allowed) {
      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'plan.approve.denied',
        resourceType: 'schema_plan',
        target: plan.title,
        status: 'denied',
        detail: auth.reason || 'Approval policy denied.',
      });
      return res.status(403).json({ error: auth.reason });
    }

    const updated = controlPlane.updateChangePlanStatus(workspaceId, plan.id, {
      status: 'approved',
      approvedById: summary.currentActor.id,
      approvedByName: summary.currentActor.name,
    });
    controlPlane.appendAuditEvent({
      workspaceId,
      actorId: summary.currentActor.id,
      actorName: summary.currentActor.name,
      actorRole: summary.currentActor.role,
      action: 'plan.approved',
      resourceType: 'schema_plan',
      target: plan.title,
      status: 'succeeded',
      detail: `Approved change plan digest ${plan.digest}.`,
    });
    res.json({ plan: updated });
  });

  app.post('/api/plans/:planId/execute', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const plan = controlPlane.getChangePlan(workspaceId, req.params.planId);
    if (!plan) return res.status(404).json({ error: 'Change plan not found.' });

    const conn = controlPlane.getConnection(workspaceId, plan.connectionId);
    if (!conn) return res.status(404).json({ error: 'Target connection not found.' });

    try {
      const currentSnapshot = await getOrRefreshSnapshot(workspaceId, conn, true);
      const auth = canExecuteChangePlan(
        summary.currentActor,
        plan,
        conn,
        currentSnapshot.fingerprint,
        req.body?.confirmText
      );
      if (!auth.allowed) {
        controlPlane.appendAuditEvent({
          workspaceId,
          actorId: summary.currentActor.id,
          actorName: summary.currentActor.name,
          actorRole: summary.currentActor.role,
          action: 'plan.execute.denied',
          resourceType: 'schema_plan',
          target: plan.title,
          databaseName: conn.database,
          status: 'denied',
          detail: auth.reason || 'Execution gate failed.',
        });
        return res.status(403).json({ error: auth.reason });
      }

      controlPlane.updateChangePlanStatus(workspaceId, plan.id, { status: 'executing' });

      const execSummary =
        conn.method === 'local_sandbox'
          ? sandboxDb.applyOperations(plan.operations, currentSnapshot)
          : await applyMssqlOperations(
              conn,
              controlPlane.getConnectionSecret(workspaceId, conn.id),
              plan.operations,
              currentSnapshot
            );

      const nextSnapshot = await getOrRefreshSnapshot(workspaceId, conn, true);
      const updated = controlPlane.updateChangePlanStatus(workspaceId, plan.id, {
        status: 'succeeded',
        executedAt: new Date().toISOString(),
        executionSummary: execSummary,
        errorMessage: null,
      });

      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'plan.executed',
        resourceType: 'schema_plan',
        target: plan.title,
        databaseName: conn.database,
        status: 'succeeded',
        detail: `${execSummary} Snapshot updated ${currentSnapshot.fingerprint} -> ${nextSnapshot.fingerprint}.`,
      });

      res.json({ plan: updated, snapshot: nextSnapshot });
    } catch (err) {
      const msg = redactSensitiveText(err instanceof Error ? err.message : 'Execution failed.');
      const failedPlan = controlPlane.updateChangePlanStatus(workspaceId, plan.id, {
        status: 'failed',
        errorMessage: msg,
      });
      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'plan.execute.failed',
        resourceType: 'schema_plan',
        target: plan.title,
        databaseName: conn.database,
        status: 'failed',
        detail: msg,
      });
      res.status(400).json({ error: msg, plan: failedPlan });
    }
  });

  // Audit log
  app.get('/api/audit', (req, res) => {
    const { workspaceId } = getTenant(res);
    res.json({ events: controlPlane.listAuditEvents(workspaceId, 150) });
  });

  // Windows Connector Agent management (CONN-06, CONN-07)
  app.get('/api/agents', (req, res) => {
    const { workspaceId } = getTenant(res);
    res.json({ agents: controlPlane.listAgents(workspaceId) });
  });

  app.post('/api/agents/pair', (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    if (summary.currentActor.role !== 'Owner' && summary.currentActor.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Owners and Admins can generate agent pairing tokens.' });
    }
    const schema = z.object({
      name: z.string().min(2).max(80),
      hostname: z.string().min(2).max(120),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Provide an agent name and Windows hostname.' });

    const created = controlPlane.createAgentPairing(workspaceId, parsed.data.name, parsed.data.hostname);
    controlPlane.appendAuditEvent({
      workspaceId,
      actorId: summary.currentActor.id,
      actorName: summary.currentActor.name,
      actorRole: summary.currentActor.role,
      action: 'agent.pairing_issued',
      resourceType: 'agent',
      target: created.agent.name,
      status: 'succeeded',
      detail: `Issued expiring outbound pairing token for host ${created.agent.hostname}.`,
    });
    res.status(201).json(created);
  });

  app.patch('/api/agents/:agentId', (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    if (summary.currentActor.role !== 'Owner' && summary.currentActor.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Owners and Admins can approve or revoke agents.' });
    }
    const status = z.enum(['online', 'offline', 'pending_approval', 'revoked']).parse(req.body?.status);
    controlPlane.updateAgentStatus(workspaceId, req.params.agentId, status);
    controlPlane.appendAuditEvent({
      workspaceId,
      actorId: summary.currentActor.id,
      actorName: summary.currentActor.name,
      actorRole: summary.currentActor.role,
      action: `agent.status.${status}`,
      resourceType: 'agent',
      target: req.params.agentId,
      status: 'succeeded',
      detail: `Agent state transitioned to ${status}.`,
    });
    res.json({ updated: true });
  });

  // AI Database Assistant (opt-in, server-side Gemini, metadata only)
  app.post('/api/ai/schema-draft', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    if (!summary.policy.aiAssistantEnabled || !summary.policy.aiSchemaSharingConsent) {
      return res.status(403).json({
        error: 'AI Assistant is disabled until a workspace Owner/Admin enables AI opt-in and schema metadata consent in Settings.',
      });
    }
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Describe the database tables you want to design.' });

    const connId = req.body?.connectionId ? String(req.body.connectionId) : null;
    const snapshot = connId ? controlPlane.getSchemaSnapshot(workspaceId, connId) : null;
    try {
      const proposal = await generateSchemaDraftWithAi(prompt, snapshot);
      res.json({ proposal });
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'AI generation failed.' });
    }
  });

  app.post('/api/ai/nl-query', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    if (!summary.policy.aiAssistantEnabled || !summary.policy.aiSchemaSharingConsent) {
      return res.status(403).json({
        error: 'AI Assistant is disabled until enabled with explicit metadata consent.',
      });
    }
    const conn = controlPlane.getConnection(workspaceId, String(req.body?.connectionId || ''));
    if (!conn) return res.status(404).json({ error: 'Select an active database connection first.' });
    const snapshot = await getOrRefreshSnapshot(workspaceId, conn, false);
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'Enter a question about your data.' });

    try {
      const generated = await generateReadOnlySqlWithAi(question, snapshot);
      res.json(generated);
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'AI query generation failed.' });
    }
  });

  // Frontend serving (Vite dev middleware in dev, dist/ in prod)
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Visual Database Studio listening on http://localhost:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
