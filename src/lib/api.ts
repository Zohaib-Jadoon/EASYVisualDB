import {
  AiRelationshipSuggestion,
  AiSchemaProposal,
  AuditEvent,
  AuthSessionInfo,
  AuthUser,
  BillingCheckoutSession,
  ChangePlan,
  ConnectionCapabilities,
  ConnectionDiagnosticStep,
  ConnectionProfile,
  DatabaseInfo,
  DiagramNodePosition,
  LocalDiscoveryResponse,
  PlanTier,
  QueryExecutionResult,
  RecordColumnFilter,
  SchemaDriftReport,
  SchemaOperation,
  SchemaSnapshot,
  SqlErrorExplanation,
  SubscriptionInfo,
  TableDependency,
  VisualQuerySpec,
  WindowsAgentRecord,
  WorkspaceInvitation,
  WorkspaceMember,
  WorkspacePolicy,
  WorkspaceRole,
  WorkspaceSummary,
} from '../shared/types';

import { getDesktopConfig } from './desktopBridge';

export interface TenantContextHeaders {
  workspaceId: string;
  actorId: string;
}

let activeContext: TenantContextHeaders = {
  workspaceId: 'ws_primary',
  actorId: 'usr_owner',
};

export function setApiTenantContext(ctx: TenantContextHeaders) {
  activeContext = ctx;
}

export function getApiTenantContext(): TenantContextHeaders {
  return activeContext;
}

async function getDesktopHeaders(): Promise<Record<string, string>> {
  const cfg = await getDesktopConfig();
  if (!cfg?.desktopToken) return {};
  return { 'x-vds-desktop-token': cfg.desktopToken };
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const desktopHeaders = await getDesktopHeaders();
  const res = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'x-workspace-id': activeContext.workspaceId,
      'x-actor-id': activeContext.actorId,
      ...desktopHeaders,
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`) as Error & {
      status?: number;
      payload?: unknown;
    };
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data as T;
}

export const api = {
  // Auth
  getAuthSession: () => apiFetch<AuthSessionInfo>('/api/auth/me'),

  login: (email: string, password: string) =>
    apiFetch<{
      user: AuthUser;
      workspaceId: string;
      workspaces: Array<{ id: string; organizationName: string; name: string; planTier: PlanTier }>;
    }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (input: { name: string; email: string; password: string; organizationName?: string }) =>
    apiFetch<{ user: AuthUser; workspaceId: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  logout: () => apiFetch<{ loggedOut: boolean }>('/api/auth/logout', { method: 'POST' }),

  acceptInvitation: (token: string, password: string) =>
    apiFetch<{ user: AuthUser; workspaceId: string; member: WorkspaceMember }>('/api/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),

  listWorkspaces: () =>
    apiFetch<{
      workspaces: Array<{ id: string; organizationName: string; name: string; planTier: PlanTier }>;
    }>('/api/workspaces'),

  getWorkspace: () =>
    apiFetch<{
      workspace: WorkspaceSummary;
      aiProviderConfigured: boolean;
      migrations: Array<{ id: string; name: string; appliedAt: string }>;
      billingProviderConfigured: boolean;
      billingEvents: BillingCheckoutSession[];
    }>('/api/workspace'),

  updatePolicy: (partial: Partial<WorkspacePolicy>) =>
    apiFetch<{ policy: WorkspacePolicy }>('/api/workspace/policy', {
      method: 'PATCH',
      body: JSON.stringify(partial),
    }),

  updatePlan: (tier: PlanTier) =>
    apiFetch<{ subscription: SubscriptionInfo }>('/api/workspace/plan', {
      method: 'PATCH',
      body: JSON.stringify({ tier }),
    }),

  createBillingCheckout: (tier: PlanTier) =>
    apiFetch<{ checkout: BillingCheckoutSession }>('/api/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ tier }),
    }),

  addMember: (input: { name: string; email: string; role: WorkspaceRole }) =>
    apiFetch<{ member: WorkspaceMember }>('/api/workspace/members', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listInvitations: () => apiFetch<{ invitations: WorkspaceInvitation[] }>('/api/workspace/invitations'),

  createInvitation: (input: { name: string; email: string; role: WorkspaceRole }) =>
    apiFetch<{ invitation: WorkspaceInvitation; inviteToken: string }>('/api/workspace/invitations', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateMember: (
    memberId: string,
    updates: Partial<{
      role: WorkspaceRole;
      schemaWrite: boolean;
      dataWrite: boolean;
      status: 'active' | 'suspended';
      mfaEnabled: boolean;
    }>
  ) =>
    apiFetch<{ member: WorkspaceMember }>(`/api/workspace/members/${memberId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  // Discovery & Connections
  discoverLocalSqlServers: (agentId?: string | null) =>
    apiFetch<LocalDiscoveryResponse>('/api/discovery/local-sql', {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    }),

  listConnections: () => apiFetch<{ connections: ConnectionProfile[] }>('/api/connections'),

  reconnectAllConnections: () =>
    apiFetch<{ connections: ConnectionProfile[] }>('/api/connections/reconnect-all', { method: 'POST' }),

  checkConnectionHealth: (connectionId: string) =>
    apiFetch<{ connection: ConnectionProfile; diagnostics?: unknown; error?: string }>(
      `/api/connections/${connectionId}/check-health`,
      { method: 'POST' }
    ),

  testConnection: (input: {
    method?: 'direct_tls' | 'azure_sql' | 'windows_agent';
    host: string;
    instanceName?: string | null;
    port: number;
    database: string;
    authMethod?: 'sql_auth' | 'entra_id' | 'windows_integrated';
    username: string;
    password: string;
    domain?: string | null;
    encrypt: boolean;
    trustServerCertificate: boolean;
    timeoutMs?: number;
    agentId?: string | null;
  }) =>
    apiFetch<{
      ok: boolean;
      steps: ConnectionDiagnosticStep[];
      engineVersion: string;
      capabilities?: ConnectionCapabilities;
      accessibleDatabases: string[];
    }>('/api/connections/test', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  createConnection: (input: Record<string, unknown>) =>
    apiFetch<{ connection: ConnectionProfile }>('/api/connections', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  mountSampleSandbox: () =>
    apiFetch<{ connection: ConnectionProfile; snapshot: SchemaSnapshot }>(
      '/api/connections/sample-sandbox',
      { method: 'POST' }
    ),

  updateConnection: (
    connectionId: string,
    updates: {
      readOnly?: boolean;
      name?: string;
      environment?: string;
      reconnectOnStartup?: boolean;
      timeoutMs?: number;
      database?: string;
      newPassword?: string;
    }
  ) =>
    apiFetch<{ connection: ConnectionProfile }>(`/api/connections/${connectionId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  deleteConnection: (connectionId: string) =>
    apiFetch<{ deleted: boolean }>(`/api/connections/${connectionId}`, {
      method: 'DELETE',
    }),

  // Database Management
  listDatabases: (connectionId: string) =>
    apiFetch<{ databases: DatabaseInfo[] }>(`/api/connections/${connectionId}/databases`),

  createDatabase: (connectionId: string, databaseName: string, collation?: string) =>
    apiFetch<{ message: string }>(`/api/connections/${connectionId}/databases`, {
      method: 'POST',
      body: JSON.stringify({ databaseName, collation }),
    }),

  renameObject: (
    connectionId: string,
    payload: { schemaName: string; tableName: string; columnName?: string; newName: string }
  ) =>
    apiFetch<{ message: string; snapshot: SchemaSnapshot }>(
      `/api/connections/${connectionId}/objects/rename`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),

  getTableDependencies: (connectionId: string, schemaName: string, tableName: string) =>
    apiFetch<{ dependencies: TableDependency[] }>(
      `/api/connections/${connectionId}/dependencies?schema=${encodeURIComponent(schemaName)}&table=${encodeURIComponent(tableName)}`
    ),

  getSchema: (connectionId: string) =>
    apiFetch<{ snapshot: SchemaSnapshot }>(`/api/connections/${connectionId}/schema`),

  refreshSchema: (connectionId: string) =>
    apiFetch<{ snapshot: SchemaSnapshot }>(`/api/connections/${connectionId}/schema/refresh`, {
      method: 'POST',
    }),

  getDiagramLayout: (connectionId: string) =>
    apiFetch<{ positions: DiagramNodePosition[] }>(`/api/connections/${connectionId}/diagram-layout`),

  saveDiagramLayout: (connectionId: string, positions: DiagramNodePosition[]) =>
    apiFetch<{ saved: boolean }>(`/api/connections/${connectionId}/diagram-layout`, {
      method: 'PUT',
      body: JSON.stringify({ positions }),
    }),

  browseRecords: (
    connectionId: string,
    params: {
      schema: string;
      table: string;
      page: number;
      pageSize: number;
      sortColumn?: string;
      sortDir?: 'ASC' | 'DESC';
      search?: string;
      filters?: RecordColumnFilter[];
    }
  ) => {
    const qs = new URLSearchParams({
      schema: params.schema,
      table: params.table,
      page: String(params.page),
      pageSize: String(params.pageSize),
      ...(params.sortColumn ? { sortColumn: params.sortColumn } : {}),
      ...(params.sortDir ? { sortDir: params.sortDir } : {}),
      ...(params.search ? { search: params.search } : {}),
      ...(params.filters && params.filters.length > 0 ? { filters: JSON.stringify(params.filters) } : {}),
    });
    return apiFetch<{
      rows: Record<string, unknown>[];
      totalRows: number;
      page: number;
      pageSize: number;
    }>(`/api/connections/${connectionId}/records?${qs.toString()}`);
  },

  insertRecord: (
    connectionId: string,
    schemaName: string,
    tableName: string,
    values: Record<string, unknown>
  ) =>
    apiFetch<{ inserted: boolean }>(`/api/connections/${connectionId}/records`, {
      method: 'POST',
      body: JSON.stringify({ schemaName, tableName, values }),
    }),

  updateRecord: (
    connectionId: string,
    payload: {
      schemaName: string;
      tableName: string;
      pkValues: Record<string, unknown>;
      updates: Record<string, unknown>;
      originalValues: Record<string, unknown>;
    }
  ) =>
    apiFetch<{ updated: boolean }>(`/api/connections/${connectionId}/records`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  bulkUpdateRecords: (
    connectionId: string,
    payload: {
      schemaName: string;
      tableName: string;
      pkColumn: string;
      pkValues: Array<string | number>;
      column: string;
      value: unknown;
    }
  ) =>
    apiFetch<{ updatedCount: number }>(`/api/connections/${connectionId}/records/bulk-update`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteRecords: (
    connectionId: string,
    payload: {
      schemaName: string;
      tableName: string;
      pkColumn: string;
      pkValues: Array<string | number>;
    }
  ) =>
    apiFetch<{ deletedCount: number }>(`/api/connections/${connectionId}/records`, {
      method: 'DELETE',
      body: JSON.stringify(payload),
    }),

  importCsv: (
    connectionId: string,
    payload: { schemaName: string; tableName: string; rows: Record<string, unknown>[] }
  ) =>
    apiFetch<{ committed: number; skipped: number; errors: Array<{ rowIndex: number; error: string }> }>(
      `/api/connections/${connectionId}/import-csv`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),

  importFile: (
    connectionId: string,
    payload: { schemaName: string; tableName: string; fileName: string; fileBase64: string }
  ) =>
    apiFetch<{ committed: number; skipped: number; errors: Array<{ rowIndex: number; error: string }> }>(
      `/api/connections/${connectionId}/import-file`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),

  // SQL Tools
  formatSql: (sql: string) =>
    apiFetch<{ formatted: string }>('/api/sql/format', {
      method: 'POST',
      body: JSON.stringify({ sql }),
    }),

  explainSqlError: (error: string) =>
    apiFetch<{ explanation: SqlErrorExplanation }>('/api/sql/explain-error', {
      method: 'POST',
      body: JSON.stringify({ error }),
    }),

  runVisualQuery: (connectionId: string, spec: VisualQuerySpec) =>
    apiFetch<{ result: QueryExecutionResult }>(`/api/connections/${connectionId}/query/visual`, {
      method: 'POST',
      body: JSON.stringify(spec),
    }),

  runSqlQuery: (connectionId: string, sql: string, options?: { timeoutMs?: number; maxRows?: number }) =>
    apiFetch<{ result: QueryExecutionResult }>(`/api/connections/${connectionId}/query/sql`, {
      method: 'POST',
      body: JSON.stringify({ sql, ...options }),
    }),

  listQueries: (connectionId: string) =>
    apiFetch<{
      saved: Array<{ id: string; name: string; sql_text: string; created_by: string; created_at: string }>;
      history: Array<{
        id: string;
        actor_name: string;
        sql_text: string;
        row_count: number;
        duration_ms: number;
        status: string;
        executed_at: string;
      }>;
    }>(`/api/connections/${connectionId}/queries`),

  saveQuery: (connectionId: string, name: string, sqlText: string) =>
    apiFetch<{ query: { id: string; name: string; sql_text: string } }>(
      `/api/connections/${connectionId}/queries`,
      {
        method: 'POST',
        body: JSON.stringify({ name, sqlText }),
      }
    ),

  // Change Center
  listPlans: (connectionId?: string) =>
    apiFetch<{ plans: ChangePlan[] }>(
      connectionId ? `/api/plans?connectionId=${encodeURIComponent(connectionId)}` : '/api/plans'
    ),

  createPlan: (connectionId: string, title: string, operations: SchemaOperation[]) =>
    apiFetch<{ plan: ChangePlan }>('/api/plans', {
      method: 'POST',
      body: JSON.stringify({ connectionId, title, operations }),
    }),

  checkPlanDrift: (planId: string) =>
    apiFetch<{ report: SchemaDriftReport; liveSnapshot: SchemaSnapshot }>(`/api/plans/${planId}/drift`),

  revalidatePlan: (planId: string) =>
    apiFetch<{ plan: ChangePlan; snapshot: SchemaSnapshot }>(`/api/plans/${planId}/revalidate`, {
      method: 'POST',
    }),

  deletePlan: (planId: string) =>
    apiFetch<{ deleted: boolean }>(`/api/plans/${planId}`, { method: 'DELETE' }),

  approvePlan: (planId: string) =>
    apiFetch<{ plan: ChangePlan }>(`/api/plans/${planId}/approve`, { method: 'POST' }),

  executePlan: (planId: string, confirmText?: string) =>
    apiFetch<{ plan: ChangePlan; snapshot: SchemaSnapshot }>(`/api/plans/${planId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ confirmText }),
    }),

  listAudit: () => apiFetch<{ events: AuditEvent[] }>('/api/audit'),

  listAgents: () => apiFetch<{ agents: WindowsAgentRecord[] }>('/api/agents'),

  pairAgent: (name: string, hostname: string) =>
    apiFetch<{ agent: WindowsAgentRecord; oneTimeToken: string }>('/api/agents/pair', {
      method: 'POST',
      body: JSON.stringify({ name, hostname }),
    }),

  updateAgentStatus: (agentId: string, status: WindowsAgentRecord['status']) =>
    apiFetch<{ updated: boolean }>(`/api/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  aiSchemaDraft: (prompt: string, connectionId?: string | null) =>
    apiFetch<{ proposal: AiSchemaProposal }>('/api/ai/schema-draft', {
      method: 'POST',
      body: JSON.stringify({ prompt, connectionId }),
    }),

  aiNlQuery: (question: string, connectionId: string) =>
    apiFetch<{ sql: string; explanation: string }>('/api/ai/nl-query', {
      method: 'POST',
      body: JSON.stringify({ question, connectionId }),
    }),

  aiExplainSql: (sql: string, connectionId?: string | null) =>
    apiFetch<{ summary: string; steps: string[]; safetyNotes: string[] }>('/api/ai/explain-sql', {
      method: 'POST',
      body: JSON.stringify({ sql, connectionId }),
    }),

  aiSuggestRelationships: (connectionId: string) =>
    apiFetch<{ suggestions: AiRelationshipSuggestion[] }>('/api/ai/suggest-relationships', {
      method: 'POST',
      body: JSON.stringify({ connectionId }),
    }),

  aiGenerateDocs: (connectionId: string, useAi = true) =>
    apiFetch<{ markdown: string; source: 'gemini' | 'deterministic' }>('/api/ai/generate-docs', {
      method: 'POST',
      body: JSON.stringify({ connectionId, useAi }),
    }),

  getDesktopCapabilities: () =>
    apiFetch<{
      desktopMode: boolean;
      platform: string;
      nodeVersion: string;
      windowsAuth: {
        platform: string;
        nativeSspiAvailable: boolean;
        driverName: 'msnodesqlv8' | 'tedious-ntlm-only';
        odbcDriverHint: string;
        detail: string;
      };
    }>('/api/desktop/capabilities'),

  exportExcelBase64: async (connectionId: string, schemaName: string, tableName: string): Promise<string> => {
    const desktopHeaders = await getDesktopHeaders();
    const res = await fetch(
      `/api/connections/${connectionId}/export-excel?schema=${encodeURIComponent(schemaName)}&table=${encodeURIComponent(tableName)}`,
      {
        credentials: 'include',
        headers: {
          'x-workspace-id': activeContext.workspaceId,
          'x-actor-id': activeContext.actorId,
          ...desktopHeaders,
        },
      }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Excel export failed');
    }
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  },
};
