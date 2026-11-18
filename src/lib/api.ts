import {
  AiSchemaProposal,
  AuditEvent,
  ChangePlan,
  ConnectionDiagnosticStep,
  ConnectionProfile,
  DiagramNodePosition,
  PlanTier,
  QueryExecutionResult,
  SchemaOperation,
  SchemaSnapshot,
  SubscriptionInfo,
  VisualQuerySpec,
  WindowsAgentRecord,
  WorkspaceMember,
  WorkspacePolicy,
  WorkspaceRole,
  WorkspaceSummary,
} from '../shared/types';

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

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-workspace-id': activeContext.workspaceId,
      'x-actor-id': activeContext.actorId,
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
  listWorkspaces: () =>
    apiFetch<{
      workspaces: Array<{ id: string; organizationName: string; name: string; planTier: PlanTier }>;
    }>('/api/workspaces'),

  getWorkspace: () =>
    apiFetch<{ workspace: WorkspaceSummary; aiProviderConfigured: boolean }>('/api/workspace'),

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

  addMember: (input: { name: string; email: string; role: WorkspaceRole }) =>
    apiFetch<{ member: WorkspaceMember }>('/api/workspace/members', {
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

  listConnections: () => apiFetch<{ connections: ConnectionProfile[] }>('/api/connections'),

  testConnection: (input: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    encrypt: boolean;
    trustServerCertificate: boolean;
  }) =>
    apiFetch<{
      ok: boolean;
      steps: ConnectionDiagnosticStep[];
      engineVersion: string;
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
    updates: { readOnly?: boolean; name?: string; environment?: string; newPassword?: string }
  ) =>
    apiFetch<{ connection: ConnectionProfile }>(`/api/connections/${connectionId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  deleteConnection: (connectionId: string) =>
    apiFetch<{ deleted: boolean }>(`/api/connections/${connectionId}`, {
      method: 'DELETE',
    }),

  getSchema: (connectionId: string) =>
    apiFetch<{ snapshot: SchemaSnapshot }>(`/api/connections/${connectionId}/schema`),

  refreshSchema: (connectionId: string) =>
    apiFetch<{ snapshot: SchemaSnapshot }>(`/api/connections/${connectionId}/schema/refresh`, {
      method: 'POST',
    }),

  getDiagramLayout: (connectionId: string) =>
    apiFetch<{ positions: DiagramNodePosition[] }>(
      `/api/connections/${connectionId}/diagram-layout`
    ),

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

  runVisualQuery: (connectionId: string, spec: VisualQuerySpec) =>
    apiFetch<{ result: QueryExecutionResult }>(`/api/connections/${connectionId}/query/visual`, {
      method: 'POST',
      body: JSON.stringify(spec),
    }),

  runSqlQuery: (connectionId: string, sql: string) =>
    apiFetch<{ result: QueryExecutionResult }>(`/api/connections/${connectionId}/query/sql`, {
      method: 'POST',
      body: JSON.stringify({ sql }),
    }),

  listQueries: (connectionId: string) =>
    apiFetch<{
      saved: Array<{ id: string; name: string; sql_text: string; created_by: string; created_at: string }>;
      history: Array<{ id: string; actor_name: string; sql_text: string; row_count: number; duration_ms: number; status: string; executed_at: string }>;
    }>(`/api/connections/${connectionId}/queries`),

  saveQuery: (connectionId: string, name: string, sqlText: string) =>
    apiFetch<{ query: { id: string; name: string; sql_text: string } }>(
      `/api/connections/${connectionId}/queries`,
      {
        method: 'POST',
        body: JSON.stringify({ name, sqlText }),
      }
    ),

  listPlans: (connectionId?: string) =>
    apiFetch<{ plans: ChangePlan[] }>(
      connectionId ? `/api/plans?connectionId=${encodeURIComponent(connectionId)}` : '/api/plans'
    ),

  createPlan: (connectionId: string, title: string, operations: SchemaOperation[]) =>
    apiFetch<{ plan: ChangePlan }>('/api/plans', {
      method: 'POST',
      body: JSON.stringify({ connectionId, title, operations }),
    }),

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
};
