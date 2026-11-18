import 'dotenv/config';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import ExcelJS from 'exceljs';
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
  diffSchemaSnapshots,
  explainSqlError,
  formatSql,
  generateSchemaMarkdownDocs,
} from './src/shared/sqlCompiler';
import {
  AuthUser,
  ChangePlan,
  ConnectionProfile,
  PlanTier,
  RecordColumnFilter,
  SchemaOperation,
  VisualQuerySpec,
  WorkspaceRole,
} from './src/shared/types';
import {
  diagnoseViaAgent,
  getAdapterForConnection,
  mssqlAdapter,
} from './src/server/adapters';
import { sqlServerAdapter } from './src/lib/db/sqlserver';
import { agentGateway } from './src/server/agentGateway';
import {
  explainSqlWithAi,
  generateDatabaseDocsWithAi,
  generateReadOnlySqlWithAi,
  generateSchemaDraftWithAi,
  isAiProviderConfigured,
  suggestRelationshipsWithAi,
} from './src/server/aiAssistant';
import { billingProvider } from './src/server/billingProvider';
import { controlPlane } from './src/server/controlPlane';
import { redactSensitiveText, signSessionToken, verifySessionToken } from './src/server/crypto';
import { discoverLocalWindowsSqlInstances } from './src/server/localDiscovery';
import { sandboxDb } from './src/server/sandboxDb';

const SESSION_COOKIE_NAME = 'vds_session';

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function getAuthenticatedUser(req: Request): AuthUser | null {
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (!rawToken) return null;
  const sessionId = verifySessionToken(rawToken);
  if (!sessionId) return null;
  return controlPlane.getUserBySessionId(sessionId);
}

function setSessionCookie(res: Response, sessionId: string) {
  const signed = signSessionToken(sessionId);
  res.cookie(SESSION_COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function parseCsvRows(csvText: string): Record<string, unknown>[] {
  const lines: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i += 1) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"' && csvText[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && csvText[i + 1] === '\n') i += 1;
      row.push(field.trim());
      if (row.some((cell) => cell !== '')) lines.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    if (row.some((cell) => cell !== '')) lines.push(row);
  }

  if (lines.length < 2) return [];
  const headers = lines[0];
  return lines.slice(1).map((cols) => {
    const rec: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      if (h) rec[h] = cols[idx] ?? '';
    });
    return rec;
  });
}

function getTenantContext(req: Request): { workspaceId: string; actorId: string } {
  const workspaceId = String(req.header('x-workspace-id') || 'ws_primary');
  const actorId = String(req.header('x-actor-id') || '');
  return { workspaceId, actorId };
}

function getTenant(res: Response): { workspaceId: string; actorId: string; authUser: AuthUser | null } {
  return {
    workspaceId: String(res.locals.workspaceId),
    actorId: String(res.locals.actorId),
    authUser: (res.locals.authUser as AuthUser | null) ?? null,
  };
}

function tenantMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const authUser = getAuthenticatedUser(req);
    const { workspaceId, actorId } = getTenantContext(req);
    const requireLogin = process.env.REQUIRE_LOGIN === 'true';

    if (authUser) {
      const member = controlPlane.getMemberForUserInWorkspace(workspaceId, authUser);
      if (!member) {
        return res.status(403).json({
          error: `Account "${authUser.email}" does not belong to workspace "${workspaceId}".`,
        });
      }
      res.locals.workspaceId = workspaceId;
      res.locals.actorId = member.id;
      res.locals.authUser = authUser;
      return next();
    }

    if (requireLogin) {
      return res.status(401).json({ error: 'Authentication required. Sign in to access this workspace.' });
    }

    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    res.locals.workspaceId = summary.id;
    res.locals.actorId = summary.currentActor.id;
    res.locals.authUser = null;
    next();
  } catch (err) {
    res.status(403).json({
      error: err instanceof Error ? err.message : 'Workspace access denied.',
    });
  }
}

async function reconnectAuthorizedStartupConnections() {
  const all = controlPlane.listAllConnections();
  for (const conn of all) {
    if (!conn.reconnectOnStartup) continue;
    try {
      if (conn.method === 'local_sandbox') {
        sandboxDb.ensureSeeded();
        controlPlane.updateConnection(conn.workspaceId, conn.id, {
          status: 'connected',
          lastCheckedAt: new Date().toISOString(),
          lastError: null,
        });
      } else if (conn.method === 'windows_agent') {
        const online = conn.agentId ? agentGateway.isAgentOnline(conn.workspaceId, conn.agentId) : false;
        controlPlane.updateConnection(conn.workspaceId, conn.id, {
          status: online ? 'connected' : 'disconnected',
          lastCheckedAt: new Date().toISOString(),
          lastError: online ? null : 'Waiting for paired Windows Connector Agent to come online.',
        });
      } else {
        const secret = controlPlane.getConnectionSecret(conn.workspaceId, conn.id);
        const diag = await mssqlAdapter.diagnose({
          host: conn.host,
          instanceName: conn.instanceName,
          port: conn.port,
          database: conn.database,
          authMethod: conn.authMethod,
          username: conn.username,
          password: secret,
          domain: conn.domain,
          encrypt: conn.encrypt,
          trustServerCertificate: conn.trustServerCertificate,
          timeoutMs: Math.min(conn.timeoutMs || 5000, 5000),
        });
        controlPlane.updateConnection(conn.workspaceId, conn.id, {
          status: diag.ok ? 'connected' : 'error',
          lastCheckedAt: new Date().toISOString(),
          lastError: diag.ok
            ? null
            : diag.steps.find((s) => s.status === 'failed')?.detail || 'Startup health check failed.',
          engineVersion: diag.ok ? diag.engineVersion : conn.engineVersion,
          capabilities: diag.ok ? diag.capabilities : conn.capabilities,
        });
      }
    } catch (err) {
      controlPlane.updateConnection(conn.workspaceId, conn.id, {
        status: 'disconnected',
        lastCheckedAt: new Date().toISOString(),
        lastError: redactSensitiveText(err instanceof Error ? err.message : 'Startup reconnect failed.'),
      });
    }
  }
}

export function validateDesktopRequestSecurity(
  req: Pick<Request, 'path' | 'header'> & { originalUrl?: string },
  desktopMode: boolean,
  desktopSecret: string
): { allowed: boolean; status?: number; error?: string } {
  if (!desktopMode || !desktopSecret) return { allowed: true };

  // Validate Origin/Referer if present so arbitrary websites cannot probe 127.0.0.1
  const origin = req.header('origin');
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
    return { allowed: false, status: 403, error: 'Cross-origin access to desktop backend is prohibited.' };
  }

  const normalizedPath = (req.originalUrl || req.path).split('?')[0];
  if (normalizedPath === '/api/health' || req.path === '/health') {
    return { allowed: true };
  }

  const supplied = req.header('x-vds-desktop-token') || '';
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(desktopSecret, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { allowed: false, status: 401, error: 'Missing or invalid desktop backend token.' };
  }
  return { allowed: true };
}

export async function startServer(options?: { port?: number; host?: string; staticDir?: string }) {
  const app = express();
  const desktopMode = process.env.VDS_DESKTOP_MODE === '1';
  const desktopSecret = process.env.VDS_DESKTOP_SECRET || '';
  app.use(express.json({ limit: '6mb' }));

  // Per-launch loopback security for Electron Desktop Edition
  app.use('/api', (req, res, next) => {
    const check = validateDesktopRequestSecurity(req, desktopMode, desktopSecret);
    if (!check.allowed) {
      return res.status(check.status || 403).json({ error: check.error || 'Forbidden' });
    }
    next();
  });

  app.get('/api/health', (req, res) => {
    const supplied = req.header('x-vds-desktop-token') || '';
    const tokenOk =
      !desktopMode ||
      !desktopSecret ||
      (supplied.length === desktopSecret.length &&
        crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(desktopSecret)));
    res.json({
      ok: true,
      status: 'ok',
      service: 'visual-database-studio',
      desktopMode,
      authenticated: tokenOk,
      platform: process.platform,
      nodeVersion: process.version,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/desktop/capabilities', (_req, res) => {
    res.json({
      desktopMode,
      platform: process.platform,
      nodeVersion: process.version,
      windowsAuth: sqlServerAdapter.getWindowsAuthSupport(),
    });
  });

  // Authentication endpoints (public)
  app.get('/api/auth/me', (req, res) => {
    const user = getAuthenticatedUser(req);
    res.json({
      authenticated: Boolean(user),
      user,
      demoMode: process.env.REQUIRE_LOGIN !== 'true',
    });
  });

  app.post('/api/auth/register', (req, res) => {
    const schema = z.object({
      name: z.string().min(2).max(80),
      email: z.string().email(),
      password: z.string().min(8).max(128),
      organizationName: z.string().max(100).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid registration details.' });
    }
    try {
      const created = controlPlane.registerUser(parsed.data);
      setSessionCookie(res, created.sessionId);
      controlPlane.appendAuditEvent({
        workspaceId: created.workspaceId,
        actorId: created.user.id,
        actorName: created.user.name,
        actorRole: 'Owner',
        action: 'auth.registered',
        resourceType: 'auth',
        target: created.user.email,
        status: 'succeeded',
        detail: `Registered new user and provisioned isolated workspace ${created.workspaceId}.`,
      });
      res.status(201).json({ user: created.user, workspaceId: created.workspaceId });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Registration failed.' });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid email and password are required.' });
    }
    try {
      const result = controlPlane.loginUser(parsed.data.email, parsed.data.password);
      setSessionCookie(res, result.sessionId);
      controlPlane.appendAuditEvent({
        workspaceId: result.defaultWorkspaceId,
        actorId: result.user.id,
        actorName: result.user.name,
        actorRole: 'Owner',
        action: 'auth.login',
        resourceType: 'auth',
        target: result.user.email,
        status: 'succeeded',
        detail: 'Authenticated session started via password verification.',
      });
      res.json({
        user: result.user,
        workspaceId: result.defaultWorkspaceId,
        workspaces: controlPlane.listWorkspacesForUser(result.user),
      });
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : 'Login failed.' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[SESSION_COOKIE_NAME];
    if (raw) {
      const sessionId = verifySessionToken(raw);
      if (sessionId) controlPlane.deleteSession(sessionId);
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.json({ loggedOut: true });
  });

  app.post('/api/invitations/accept', (req, res) => {
    const schema = z.object({
      token: z.string().min(6),
      password: z.string().min(8).max(128),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Provide invite token and password.' });
    }
    try {
      const accepted = controlPlane.acceptInvitation(parsed.data.token, parsed.data.password);
      setSessionCookie(res, accepted.sessionId);
      controlPlane.appendAuditEvent({
        workspaceId: accepted.workspaceId,
        actorId: accepted.member.id,
        actorName: accepted.member.name,
        actorRole: accepted.member.role,
        action: 'workspace.invitation.accepted',
        resourceType: 'auth',
        target: accepted.member.email,
        status: 'succeeded',
        detail: `Accepted workspace invitation as ${accepted.member.role}.`,
      });
      res.json({ user: accepted.user, workspaceId: accepted.workspaceId, member: accepted.member });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to accept invitation.' });
    }
  });

  // Billing webhook endpoint (verifies HMAC signature when BILLING_WEBHOOK_SECRET is configured)
  app.post('/api/billing/webhook', (req, res) => {
    const sig = req.header('x-vds-billing-signature');
    const rawBody = JSON.stringify(req.body ?? {});
    if (!billingProvider.verifyWebhookSignature(rawBody, sig)) {
      return res.status(401).json({ error: 'Invalid billing webhook signature.' });
    }
    const workspaceId = String(req.body?.workspaceId || '');
    const targetTier = z.enum(['free', 'pro', 'team', 'enterprise']).safeParse(req.body?.targetTier);
    if (!workspaceId || !targetTier.success) {
      return res.status(400).json({ error: 'Invalid billing webhook payload.' });
    }
    const subscription = controlPlane.updatePlanTier(workspaceId, targetTier.data);
    controlPlane.recordBillingEvent({
      id: `whk_${crypto.randomBytes(5).toString('hex')}`,
      workspaceId,
      provider: billingProvider.providerName,
      targetTier: targetTier.data,
      status: 'completed',
      checkoutUrl: null,
      note: `Webhook applied plan tier ${targetTier.data}.`,
      createdAt: new Date().toISOString(),
    });
    res.json({ applied: true, subscription });
  });

  // Workspaces list (filtered for signed-in users, or all demo workspaces on localhost before login)
  app.get('/api/workspaces', (req, res) => {
    const authUser = getAuthenticatedUser(req);
    if (authUser) {
      return res.json({ workspaces: controlPlane.listWorkspacesForUser(authUser) });
    }
    if (process.env.REQUIRE_LOGIN === 'true') {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    res.json({ workspaces: controlPlane.listWorkspaces() });
  });

  // SQL utilities (pure stateless syntax tools)
  app.post('/api/sql/format', (req, res) => {
    const sqlText = String(req.body?.sql || '');
    res.json({ formatted: formatSql(sqlText) });
  });

  app.post('/api/sql/explain-error', (req, res) => {
    const errorMessage = String(req.body?.error || '');
    res.json({ explanation: explainSqlError(errorMessage) });
  });

  // All subsequent /api routes require valid tenant context
  app.use('/api', tenantMiddleware);

  app.get('/api/workspace', (_req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    res.json({
      workspace: summary,
      aiProviderConfigured: isAiProviderConfigured(),
      migrations: controlPlane.getMigrations(),
      billingProviderConfigured: billingProvider.isConfigured(),
      billingEvents: controlPlane.listBillingEvents(workspaceId),
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
      detail: 'Updated workspace security & AI governance settings.',
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

  app.post('/api/billing/checkout', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    if (summary.currentActor.role !== 'Owner') {
      return res.status(403).json({ error: 'Only the Workspace Owner can initiate billing checkout.' });
    }
    const parsed = z.object({ tier: z.enum(['free', 'pro', 'team', 'enterprise']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid subscription tier.' });

    const session = await billingProvider.createCheckoutSession(workspaceId, parsed.data.tier);
    controlPlane.recordBillingEvent(session);
    res.json({ checkout: session });
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

  app.get('/api/workspace/invitations', (_req, res) => {
    const { workspaceId } = getTenant(res);
    res.json({ invitations: controlPlane.listInvitations(workspaceId) });
  });

  app.post('/api/workspace/invitations', (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    if (summary.currentActor.role !== 'Owner' && summary.currentActor.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Owners and Admins can create team invitations.' });
    }
    const schema = z.object({
      name: z.string().min(2).max(80),
      email: z.string().email(),
      role: z.enum(['Owner', 'Admin', 'Designer', 'Data Editor', 'Viewer']),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid invitation details.' });
    }
    const created = controlPlane.createInvitation(workspaceId, {
      ...parsed.data,
      role: parsed.data.role as WorkspaceRole,
      invitedByName: summary.currentActor.name,
    });
    controlPlane.appendAuditEvent({
      workspaceId,
      actorId: summary.currentActor.id,
      actorName: summary.currentActor.name,
      actorRole: summary.currentActor.role,
      action: 'workspace.invitation.created',
      resourceType: 'policy',
      target: created.invitation.email,
      status: 'succeeded',
      detail: `Issued 7-day invitation token for ${created.invitation.name} (${created.invitation.role}).`,
    });
    res.status(201).json(created);
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

  // Consent-driven Local SQL Server Discovery (via live Windows Connector Agent or local Windows host)
  app.post('/api/discovery/local-sql', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const requestedAgentId = req.body?.agentId ? String(req.body.agentId) : null;

    try {
      const targetAgent =
        requestedAgentId && agentGateway.isAgentOnline(workspaceId, requestedAgentId)
          ? { agentId: requestedAgentId }
          : agentGateway.findOnlineAgentForWorkspace(workspaceId);

      if (targetAgent) {
        const agentRecord = controlPlane
          .listAgents(workspaceId)
          .find((a) => a.id === targetAgent.agentId);
        const result = await agentGateway.callAgent<{
          instances: import('./src/shared/types').DiscoveredSqlInstance[];
          hostname: string;
          osInfo: string;
        }>(workspaceId, targetAgent.agentId, 'discover_instances', {
          userInitiated: true,
        });

        controlPlane.appendAuditEvent({
          workspaceId,
          actorId: summary.currentActor.id,
          actorName: summary.currentActor.name,
          actorRole: summary.currentActor.role,
          action: 'discovery.local_sql.agent',
          resourceType: 'agent',
          target: agentRecord?.name || targetAgent.agentId,
          status: 'succeeded',
          detail: `User-initiated SQL Server discovery via Windows Agent found ${result.instances.length} instance(s).`,
        });

        return res.json({
          supported: true,
          hostPlatform: 'win32 (Windows Connector Agent)',
          viaAgentId: targetAgent.agentId,
          viaAgentName: agentRecord?.name || targetAgent.agentId,
          instances: result.instances,
          message:
            result.instances.length > 0
              ? `Discovered ${result.instances.length} local SQL Server instance(s) on ${result.hostname}. Select an instance and test authentication to list databases.`
              : `No local SQL Server services were detected on ${result.hostname}.`,
          checkedAt: new Date().toISOString(),
        });
      }

      const localResult = await discoverLocalWindowsSqlInstances();
      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'discovery.local_sql.host',
        resourceType: 'connection',
        target: process.platform,
        status: 'succeeded',
        detail: `User-initiated local SQL Server discovery (${process.platform}): ${localResult.instances.length} instance(s).`,
      });
      res.json(localResult);
    } catch (err) {
      res.status(400).json({
        error: redactSensitiveText(err instanceof Error ? err.message : 'Local SQL Server discovery failed.'),
      });
    }
  });

  // Connections
  app.get('/api/connections', (_req, res) => {
    const { workspaceId } = getTenant(res);
    res.json({ connections: controlPlane.listConnections(workspaceId) });
  });

  app.post('/api/connections/reconnect-all', async (_req, res) => {
    await reconnectAuthorizedStartupConnections();
    const { workspaceId } = getTenant(res);
    res.json({ connections: controlPlane.listConnections(workspaceId) });
  });

  app.post('/api/connections/test', async (req, res) => {
    const { workspaceId } = getTenant(res);
    const schema = z.object({
      method: z.enum(['direct_tls', 'azure_sql', 'windows_agent']).default('direct_tls'),
      host: z.string().min(1),
      instanceName: z.string().optional().nullable(),
      port: z.number().int().min(1).max(65535).default(1433),
      database: z.string().default('master'),
      authMethod: z.enum(['sql_auth', 'entra_id', 'windows_integrated']).default('sql_auth'),
      username: z.string().default(''),
      password: z.string().default(''),
      domain: z.string().optional().nullable(),
      encrypt: z.boolean().default(true),
      trustServerCertificate: z.boolean().default(false),
      timeoutMs: z.number().int().min(1000).max(60000).default(8000),
      agentId: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid connection parameters.' });
    }
    try {
      const result =
        parsed.data.method === 'windows_agent' && parsed.data.agentId
          ? await diagnoseViaAgent(workspaceId, parsed.data.agentId, parsed.data)
          : await mssqlAdapter.diagnose(parsed.data);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Connection test failed.') });
    }
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
      instanceName: z.string().optional().nullable(),
      port: z.number().int().min(1).max(65535).default(1433),
      database: z.string().min(1),
      authMethod: z.enum(['sql_auth', 'entra_id', 'windows_integrated']).default('sql_auth'),
      username: z.string().default(''),
      password: z.string().default(''),
      domain: z.string().optional().nullable(),
      encrypt: z.boolean().default(true),
      trustServerCertificate: z.boolean().default(false),
      environment: z.enum(['development', 'staging', 'production']).default('development'),
      readOnly: z.boolean().default(true),
      timeoutMs: z.number().int().min(1000).max(60000).default(8000),
      reconnectOnStartup: z.boolean().default(true),
      agentId: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid connection payload.' });
    }

    try {
      const diag =
        parsed.data.method === 'windows_agent' && parsed.data.agentId
          ? await diagnoseViaAgent(workspaceId, parsed.data.agentId, parsed.data)
          : await mssqlAdapter.diagnose(parsed.data);

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
          instanceName: parsed.data.instanceName ?? null,
          port: parsed.data.port,
          database: parsed.data.database,
          authMethod: parsed.data.authMethod,
          username: parsed.data.username,
          domain: parsed.data.domain ?? null,
          encrypt: parsed.data.encrypt,
          trustServerCertificate: parsed.data.trustServerCertificate,
          readOnly: parsed.data.readOnly ?? true,
          timeoutMs: parsed.data.timeoutMs,
          reconnectOnStartup: parsed.data.reconnectOnStartup,
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
        const adapter = getAdapterForConnection(saved);
        const snapshot = await adapter.introspect(saved, parsed.data.password);
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
        detail: `Connected ${saved.method} (${saved.authMethod}) in ${saved.readOnly ? 'Read-Only' : 'Read-Write'} mode.`,
      });

      res.status(201).json({ connection: saved, diagnostics: diag });
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Unable to save connection.') });
    }
  });

  // Explicit Interactive Sample Sandbox provisioning
  app.post('/api/connections/sample-sandbox', (_req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const existing = controlPlane.listConnections(workspaceId).find((c) => c.method === 'local_sandbox');

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
        instanceName: null,
        port: 1433,
        database: 'NorthwindOps_Sample',
        authMethod: 'sandbox_local',
        username: 'sandbox_explorer',
        domain: null,
        encrypt: true,
        trustServerCertificate: true,
        readOnly: true,
        timeoutMs: 8000,
        reconnectOnStartup: true,
        environment: 'sandbox',
        status: 'connected',
        engineVersion: 'Local SQL Sandbox (Optional SQLite Learning Engine)',
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
      detail: 'Mounted optional sample SQLite learning database in Read-Only (Explorer) mode.',
    });

    res.status(201).json({ connection: saved, snapshot });
  });

  app.patch('/api/connections/:connectionId', async (req, res) => {
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
      reconnectOnStartup: typeof req.body?.reconnectOnStartup === 'boolean' ? req.body.reconnectOnStartup : undefined,
      timeoutMs: typeof req.body?.timeoutMs === 'number' ? req.body.timeoutMs : undefined,
      database: typeof req.body?.database === 'string' ? req.body.database : undefined,
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
      detail: `Access mode: ${updated.readOnly ? 'Read-Only' : 'Read-Write'}, Environment: ${updated.environment}, Database: ${updated.database}.`,
    });

    res.json({ connection: updated });
  });

  app.post('/api/connections/:connectionId/check-health', async (req, res) => {
    const { workspaceId } = getTenant(res);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    try {
      const secret = controlPlane.getConnectionSecret(workspaceId, conn.id);
      const diag =
        conn.method === 'windows_agent' && conn.agentId
          ? await diagnoseViaAgent(workspaceId, conn.agentId, { ...conn, password: secret })
          : await getAdapterForConnection(conn).diagnose({ ...conn, password: secret });

      const updated = controlPlane.updateConnection(workspaceId, conn.id, {
        status: diag.ok ? 'connected' : 'error',
        lastCheckedAt: new Date().toISOString(),
        lastError: diag.ok ? null : diag.steps.find((s) => s.status === 'failed')?.detail || 'Health check failed.',
        engineVersion: diag.ok ? diag.engineVersion : conn.engineVersion,
        capabilities: diag.ok ? diag.capabilities : conn.capabilities,
      });
      res.json({ connection: updated, diagnostics: diag });
    } catch (err) {
      const msg = redactSensitiveText(err instanceof Error ? err.message : 'Health check failed.');
      const updated = controlPlane.updateConnection(workspaceId, conn.id, {
        status: 'disconnected',
        lastCheckedAt: new Date().toISOString(),
        lastError: msg,
      });
      res.json({ connection: updated, error: msg });
    }
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

  // Database Management (list databases, inspect properties, create database, rename object, dependencies)
  app.get('/api/connections/:connectionId/databases', async (req, res) => {
    const { workspaceId } = getTenant(res);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });
    try {
      const adapter = getAdapterForConnection(conn);
      const databases = await adapter.listDatabases(conn, controlPlane.getConnectionSecret(workspaceId, conn.id));
      res.json({ databases });
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Unable to list databases.') });
    }
  });

  app.post('/api/connections/:connectionId/databases', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });
    if (summary.currentActor.role !== 'Owner' && summary.currentActor.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Workspace Owners and Admins can create server databases.' });
    }
    if (conn.readOnly) {
      return res.status(403).json({ error: 'Connection is Read-Only. Enable Write Access before creating a database.' });
    }
    const dbName = String(req.body?.databaseName || '').trim();
    const collation = req.body?.collation ? String(req.body.collation).trim() : undefined;
    try {
      const adapter = getAdapterForConnection(conn);
      const message = await adapter.createDatabase(
        conn,
        controlPlane.getConnectionSecret(workspaceId, conn.id),
        dbName,
        collation
      );
      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'database.created',
        resourceType: 'database',
        target: dbName,
        databaseName: dbName,
        status: 'succeeded',
        detail: message,
      });
      res.status(201).json({ message });
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Database creation failed.') });
    }
  });

  app.post('/api/connections/:connectionId/objects/rename', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    const auth = canModifySchema(summary.currentActor, conn);
    if (!auth.allowed) return res.status(403).json({ error: auth.reason });

    const { schemaName, tableName, columnName, newName } = req.body ?? {};
    try {
      const adapter = getAdapterForConnection(conn);
      const message = await adapter.renameObject(
        conn,
        controlPlane.getConnectionSecret(workspaceId, conn.id),
        { schemaName, tableName, columnName, newName }
      );
      const snapshot = await getOrRefreshSnapshot(workspaceId, conn, true);
      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'schema.object.renamed',
        resourceType: 'database',
        target: columnName ? `${schemaName}.${tableName}.${columnName}` : `${schemaName}.${tableName}`,
        databaseName: conn.database,
        status: 'succeeded',
        detail: message,
      });
      res.json({ message, snapshot });
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Rename failed.') });
    }
  });

  app.get('/api/connections/:connectionId/dependencies', async (req, res) => {
    const { workspaceId } = getTenant(res);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });
    const schemaName = String(req.query.schema || 'dbo');
    const tableName = String(req.query.table || '');
    if (!tableName) return res.status(400).json({ error: 'Table name is required.' });
    try {
      const adapter = getAdapterForConnection(conn);
      const dependencies = await adapter.getDependencies(
        conn,
        controlPlane.getConnectionSecret(workspaceId, conn.id),
        schemaName,
        tableName
      );
      res.json({ dependencies });
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Unable to load dependencies.') });
    }
  });

  // Schema discovery & refresh
  async function getOrRefreshSnapshot(workspaceId: string, conn: ConnectionProfile, forceRefresh = false) {
    if (!forceRefresh) {
      const cached = controlPlane.getSchemaSnapshot(workspaceId, conn.id);
      if (cached) return cached;
    }
    const adapter = getAdapterForConnection(conn);
    const snapshot = await adapter.introspect(conn, controlPlane.getConnectionSecret(workspaceId, conn.id));
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

  // Records Grid CRUD + Structured Filters + Bulk Operations + Excel/CSV Import & Export
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
    let filters: RecordColumnFilter[] | undefined;
    if (req.query.filters) {
      try {
        filters = JSON.parse(String(req.query.filters)) as RecordColumnFilter[];
      } catch {
        return res.status(400).json({ error: 'Malformed column filters JSON.' });
      }
    }

    try {
      const snapshot = await getOrRefreshSnapshot(workspaceId, conn, false);
      const table = snapshot.tables.find((t) => t.schemaName === schemaName && t.tableName === tableName);
      if (!table) return res.status(404).json({ error: `Table ${schemaName}.${tableName} not found.` });

      const columns = table.columns.map((c) => c.name);
      const adapter = getAdapterForConnection(conn);
      const data = await adapter.browseRows(conn, controlPlane.getConnectionSecret(workspaceId, conn.id), {
        schemaName,
        tableName,
        page,
        pageSize,
        sortColumn,
        sortDir,
        search,
        filters,
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

      const adapter = getAdapterForConnection(conn);
      await adapter.insertRow(conn, controlPlane.getConnectionSecret(workspaceId, conn.id), schemaName, tableName, values ?? {});

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
    if (!auth.allowed) return res.status(403).json({ error: auth.reason });

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

      const adapter = getAdapterForConnection(conn);
      const resUpdate = await adapter.updateRowWithConcurrency(
        conn,
        controlPlane.getConnectionSecret(workspaceId, conn.id),
        { schemaName, tableName, pkValues, updates, originalValues }
      );
      if (resUpdate.updatedCount === 0) {
        return res.status(409).json({
          error: 'Concurrency conflict: this record was modified or deleted by another session. Refresh the grid before retrying.',
        });
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

  app.post('/api/connections/:connectionId/records/bulk-update', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    const auth = canModifyData(summary.currentActor, conn);
    if (!auth.allowed) return res.status(403).json({ error: auth.reason });

    const { schemaName, tableName, pkColumn, pkValues, column, value } = req.body ?? {};
    if (!Array.isArray(pkValues) || pkValues.length === 0 || !column) {
      return res.status(400).json({ error: 'Select rows and specify a target column for bulk update.' });
    }
    try {
      const adapter = getAdapterForConnection(conn);
      const result = await adapter.bulkUpdateRows(
        conn,
        controlPlane.getConnectionSecret(workspaceId, conn.id),
        { schemaName, tableName, pkColumn, pkValues, column, value }
      );
      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'record.bulk_updated',
        resourceType: 'record',
        target: `${schemaName}.${tableName}`,
        databaseName: conn.database,
        status: 'succeeded',
        detail: `Bulk updated column "${column}" across ${result.updatedCount} record(s).`,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Bulk update failed.') });
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

      const adapter = getAdapterForConnection(conn);
      const { deletedCount } = await adapter.deleteRowsByPk(
        conn,
        controlPlane.getConnectionSecret(workspaceId, conn.id),
        schemaName,
        tableName,
        pkColumn,
        pkValues
      );

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

  // Excel (.xlsx) Export
  app.get('/api/connections/:connectionId/export-excel', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    const schemaName = String(req.query.schema || 'dbo');
    const tableName = String(req.query.table || '');
    try {
      const snapshot = await getOrRefreshSnapshot(workspaceId, conn, false);
      const table = snapshot.tables.find((t) => t.schemaName === schemaName && t.tableName === tableName);
      if (!table) return res.status(404).json({ error: 'Table not found.' });

      const columns = table.columns.map((c) => c.name);
      const maxRows = Math.min(summary.policy.maxExportRows || 1000, 1000);
      const adapter = getAdapterForConnection(conn);
      const data = await adapter.browseRows(conn, controlPlane.getConnectionSecret(workspaceId, conn.id), {
        schemaName,
        tableName,
        page: 1,
        pageSize: Math.min(maxRows, 200),
        columns,
      });

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(tableName.slice(0, 31));
      ws.addRow(columns);
      ws.getRow(1).font = { bold: true };
      for (const r of data.rows) {
        ws.addRow(columns.map((c) => (r[c] === undefined ? null : r[c])));
      }
      const buffer = await wb.xlsx.writeBuffer();
      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'record.excel_exported',
        resourceType: 'record',
        target: `${schemaName}.${tableName}`,
        databaseName: conn.database,
        status: 'succeeded',
        detail: `Exported ${data.rows.length} row(s) to Excel (.xlsx).`,
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${tableName}.xlsx"`);
      res.send(Buffer.from(buffer));
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Excel export failed.') });
    }
  });

  // File Import (.csv or .xlsx base64)
  app.post('/api/connections/:connectionId/import-file', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    const auth = canModifyData(summary.currentActor, conn);
    if (!auth.allowed) return res.status(403).json({ error: auth.reason });

    const { schemaName, tableName, fileName, fileBase64 } = req.body ?? {};
    if (!fileBase64 || !fileName) {
      return res.status(400).json({ error: 'Provide a CSV or Excel (.xlsx) file.' });
    }

    try {
      let rows: Record<string, unknown>[] = [];
      const lowerName = String(fileName).toLowerCase();
      const buf = Buffer.from(String(fileBase64), 'base64');

      if (lowerName.endsWith('.xlsx')) {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as unknown as ArrayBuffer);
        const ws = wb.worksheets[0];
        if (!ws) throw new Error('Excel workbook contains no worksheets.');
        const headerValues: string[] = [];
        ws.getRow(1).eachCell((cell, colNumber) => {
          headerValues[colNumber] = String(cell.value ?? '').trim();
        });
        ws.eachRow((excelRow, rowNumber) => {
          if (rowNumber === 1) return;
          const rec: Record<string, unknown> = {};
          let hasAny = false;
          headerValues.forEach((h, colIdx) => {
            if (!h) return;
            const val = excelRow.getCell(colIdx).value;
            const normalized =
              val && typeof val === 'object' && 'result' in val ? (val as { result: unknown }).result : val;
            if (normalized !== null && normalized !== undefined && normalized !== '') hasAny = true;
            rec[h] = normalized ?? null;
          });
          if (hasAny) rows.push(rec);
        });
      } else {
        rows = parseCsvRows(buf.toString('utf8'));
      }

      if (rows.length === 0 || rows.length > 500) {
        return res.status(400).json({ error: `File must contain between 1 and 500 data rows (found ${rows.length}).` });
      }

      const adapter = getAdapterForConnection(conn);
      const secret = controlPlane.getConnectionSecret(workspaceId, conn.id);
      let committed = 0;
      const errors: Array<{ rowIndex: number; error: string }> = [];

      for (let i = 0; i < rows.length; i += 1) {
        try {
          await adapter.insertRow(conn, secret, schemaName, tableName, rows[i]);
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
        action: 'record.file_imported',
        resourceType: 'record',
        target: `${schemaName}.${tableName}`,
        databaseName: conn.database,
        status: committed > 0 ? 'succeeded' : 'failed',
        detail: `Imported "${fileName}": ${committed} committed, ${errors.length} skipped/rejected.`,
      });

      res.json({ committed, skipped: errors.length, errors: errors.slice(0, 20) });
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'File import failed.') });
    }
  });

  // CSV Import (paste / JSON rows)
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

    const adapter = getAdapterForConnection(conn);
    const secret = controlPlane.getConnectionSecret(workspaceId, conn.id);
    let committed = 0;
    const errors: Array<{ rowIndex: number; error: string }> = [];

    for (let i = 0; i < rows.length; i += 1) {
      try {
        await adapter.insertRow(conn, secret, schemaName, tableName, rows[i]);
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
      const compiled = compileVisualQuery(spec, conn.method === 'local_sandbox' ? 'sqlite' : 'tsql');
      const adapter = getAdapterForConnection(conn);
      const result = await adapter.executeQuery(
        conn,
        controlPlane.getConnectionSecret(workspaceId, conn.id),
        compiled.sql,
        conn.method === 'local_sandbox' ? compiled.orderedParams : compiled.params,
        false,
        { maxRows: spec.limit || 200 }
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
      const msg = redactSensitiveText(err instanceof Error ? err.message : 'Visual query failed.');
      res.status(400).json({ error: msg, explanation: explainSqlError(msg) });
    }
  });

  app.post('/api/connections/:connectionId/query/sql', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found.' });

    const sqlText = String(req.body?.sql || '');
    const timeoutMs = req.body?.timeoutMs ? Number(req.body.timeoutMs) : 15000;
    const maxRows = req.body?.maxRows ? Number(req.body.maxRows) : 200;
    const allowMutations = canModifyData(summary.currentActor, conn).allowed;

    try {
      const adapter = getAdapterForConnection(conn);
      const result = await adapter.executeQuery(
        conn,
        controlPlane.getConnectionSecret(workspaceId, conn.id),
        sqlText,
        conn.method === 'local_sandbox' ? [] : {},
        allowMutations,
        { timeoutMs, maxRows }
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
      const msg = redactSensitiveText(err instanceof Error ? err.message : 'Query execution failed.');
      controlPlane.recordQueryHistory(
        workspaceId,
        conn.id,
        summary.currentActor.name,
        sqlText,
        0,
        0,
        'failed'
      );
      res.status(400).json({ error: msg, explanation: explainSqlError(msg) });
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

  // Change Plans (Draft -> Validate -> Preview -> Drift Check -> Approve -> Execute -> Audit)
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

      controlPlane.saveChangePlan(plan, snapshot);
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

  app.get('/api/plans/:planId/drift', async (req, res) => {
    const { workspaceId } = getTenant(res);
    const plan = controlPlane.getChangePlan(workspaceId, req.params.planId);
    if (!plan) return res.status(404).json({ error: 'Change plan not found.' });
    const conn = controlPlane.getConnection(workspaceId, plan.connectionId);
    if (!conn) return res.status(404).json({ error: 'Target connection not found.' });

    try {
      const liveSnapshot = await getOrRefreshSnapshot(workspaceId, conn, true);
      const baselineSnapshot = controlPlane.getPlanBaselineSnapshot(workspaceId, plan.id);
      const report = diffSchemaSnapshots(plan.targetFingerprint, baselineSnapshot, liveSnapshot);
      res.json({ report, liveSnapshot });
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Drift check failed.') });
    }
  });

  app.post('/api/plans/:planId/revalidate', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const plan = controlPlane.getChangePlan(workspaceId, req.params.planId);
    if (!plan) return res.status(404).json({ error: 'Change plan not found.' });
    const conn = controlPlane.getConnection(workspaceId, plan.connectionId);
    if (!conn) return res.status(404).json({ error: 'Target connection not found.' });

    try {
      const liveSnapshot = await getOrRefreshSnapshot(workspaceId, conn, true);
      const compiled = compileOperationsPlan(plan.operations, liveSnapshot);
      const digest = await computeDeterministicDigest(
        JSON.stringify({ ops: plan.operations, sql: compiled.tsql, fp: liveSnapshot.fingerprint })
      );
      const requiresApproval = conn.environment === 'production' && summary.policy.requireApprovalForProduction;
      const nextStatus: ChangePlan['status'] = !compiled.preflight.passed
        ? 'draft'
        : requiresApproval
        ? 'pending_approval'
        : 'validated';

      const updated = controlPlane.revalidateChangePlan(
        workspaceId,
        plan.id,
        {
          sqlPreview: compiled.tsql,
          plainExplanation: compiled.plainExplanation,
          riskLevel: compiled.riskLevel,
          requiresConfirmText: compiled.requiresConfirmText,
          targetFingerprint: liveSnapshot.fingerprint,
          digest,
          preflight: compiled.preflight,
          status: nextStatus,
        },
        liveSnapshot
      );
      controlPlane.appendAuditEvent({
        workspaceId,
        actorId: summary.currentActor.id,
        actorName: summary.currentActor.name,
        actorRole: summary.currentActor.role,
        action: 'plan.revalidated',
        resourceType: 'schema_plan',
        target: plan.title,
        databaseName: conn.database,
        status: 'succeeded',
        detail: `Re-validated plan against live fingerprint ${liveSnapshot.fingerprint}.`,
      });
      res.json({ plan: updated, snapshot: liveSnapshot });
    } catch (err) {
      res.status(400).json({ error: redactSensitiveText(err instanceof Error ? err.message : 'Re-validation failed.') });
    }
  });

  app.delete('/api/plans/:planId', (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const plan = controlPlane.getChangePlan(workspaceId, req.params.planId);
    if (!plan) return res.status(404).json({ error: 'Change plan not found.' });
    if (plan.status === 'succeeded') {
      return res.status(400).json({ error: 'Executed historical change plans cannot be deleted.' });
    }
    controlPlane.deleteChangePlan(workspaceId, plan.id);
    controlPlane.appendAuditEvent({
      workspaceId,
      actorId: summary.currentActor.id,
      actorName: summary.currentActor.name,
      actorRole: summary.currentActor.role,
      action: 'plan.discarded',
      resourceType: 'schema_plan',
      target: plan.title,
      status: 'succeeded',
      detail: 'Discarded draft/pending change plan.',
    });
    res.json({ deleted: true });
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

      const adapter = getAdapterForConnection(conn);
      const execSummary = await adapter.applyOperations(
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
  app.get('/api/audit', (_req, res) => {
    const { workspaceId } = getTenant(res);
    res.json({ events: controlPlane.listAuditEvents(workspaceId, 150) });
  });

  // Windows Connector Agent management
  app.get('/api/agents', (_req, res) => {
    const { workspaceId } = getTenant(res);
    const list = controlPlane.listAgents(workspaceId).map((a) => ({
      ...a,
      status:
        a.status === 'revoked'
          ? 'revoked'
          : agentGateway.isAgentOnline(workspaceId, a.id)
          ? a.status === 'pending_approval'
            ? 'pending_approval'
            : 'online'
          : a.status === 'pending_approval'
          ? 'pending_approval'
          : 'offline',
    }));
    res.json({ agents: list });
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
      detail: `Issued outbound pairing token for host ${created.agent.hostname}.`,
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

  app.post('/api/ai/explain-sql', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    if (!summary.policy.aiAssistantEnabled || !summary.policy.aiSchemaSharingConsent) {
      return res.status(403).json({ error: 'Enable AI Assistant and metadata consent in Settings first.' });
    }
    const sqlText = String(req.body?.sql || '').trim();
    if (!sqlText) return res.status(400).json({ error: 'Provide SQL text to explain.' });
    const connId = req.body?.connectionId ? String(req.body.connectionId) : null;
    const snapshot = connId ? controlPlane.getSchemaSnapshot(workspaceId, connId) : null;
    try {
      const explanation = await explainSqlWithAi(sqlText, snapshot);
      res.json(explanation);
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'AI explanation failed.' });
    }
  });

  app.post('/api/ai/suggest-relationships', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    if (!summary.policy.aiAssistantEnabled || !summary.policy.aiSchemaSharingConsent) {
      return res.status(403).json({ error: 'Enable AI Assistant and metadata consent in Settings first.' });
    }
    const conn = controlPlane.getConnection(workspaceId, String(req.body?.connectionId || ''));
    if (!conn) return res.status(404).json({ error: 'Select an active database connection first.' });
    const snapshot = await getOrRefreshSnapshot(workspaceId, conn, false);
    try {
      const result = await suggestRelationshipsWithAi(snapshot);
      res.json(result);
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'AI relationship analysis failed.' });
    }
  });

  app.post('/api/ai/generate-docs', async (req, res) => {
    const { workspaceId, actorId } = getTenant(res);
    const summary = controlPlane.getWorkspaceSummary(workspaceId, actorId);
    const conn = controlPlane.getConnection(workspaceId, String(req.body?.connectionId || ''));
    if (!conn) return res.status(404).json({ error: 'Select an active database connection first.' });
    const snapshot = await getOrRefreshSnapshot(workspaceId, conn, false);

    // Deterministic data dictionary works offline even without AI; AI enriches executive summary when consented & configured
    const useAi = Boolean(
      req.body?.useAi !== false &&
        summary.policy.aiAssistantEnabled &&
        summary.policy.aiSchemaSharingConsent &&
        isAiProviderConfigured()
    );
    try {
      if (useAi) {
        const docs = await generateDatabaseDocsWithAi(snapshot);
        return res.json(docs);
      }
      res.json({ markdown: generateSchemaMarkdownDocs(snapshot), source: 'deterministic' });
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Documentation generation failed.' });
    }
  });

  // Frontend serving
  if (process.env.NODE_ENV !== 'production' && !desktopMode) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = options?.staticDir || process.env.VDS_STATIC_DIR || path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  agentGateway.attach(httpServer);

  const requestedPort =
    options?.port !== undefined
      ? options.port
      : process.env.PORT !== undefined
      ? Number(process.env.PORT)
      : 3000;
  const bindHost = options?.host || (desktopMode ? '127.0.0.1' : process.env.HOST || '0.0.0.0');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await sqlServerAdapter.closeAllPools().catch(() => undefined);
    sandboxDb.close();
    try {
      controlPlane.close();
    } catch {
      // ignore already closed
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      setTimeout(resolve, 2500);
    });
  };

  process.on('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    shutdown().finally(() => process.exit(0));
  });

  // Support Electron utilityProcess parentPort graceful shutdown signal
  const parentPort = (process as unknown as { parentPort?: { on: (e: string, cb: (d: unknown) => void) => void; postMessage: (d: unknown) => void } }).parentPort;
  if (parentPort) {
    parentPort.on('message', (msg: unknown) => {
      if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'shutdown') {
        shutdown().finally(() => process.exit(0));
      }
    });
  }

  await new Promise<void>((resolve) => {
    httpServer.listen(requestedPort, bindHost, () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort;
      console.log(`Visual Database Studio listening on http://${bindHost === '0.0.0.0' ? 'localhost' : bindHost}:${actualPort}`);
      if (desktopMode) {
        process.stdout.write(`VDS_SERVER_READY:${JSON.stringify({ port: actualPort, host: bindHost })}\n`);
      }
      if (parentPort) {
        parentPort.postMessage({ type: 'ready', port: actualPort, host: bindHost });
      }
      reconnectAuthorizedStartupConnections().catch(() => undefined);
      resolve();
    });
  });

  return { app, httpServer, shutdown };
}

if (process.env.VDS_NO_AUTOSTART !== '1') {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
