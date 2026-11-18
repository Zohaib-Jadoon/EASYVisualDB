export type AppMode = 'simple' | 'developer';

export type WorkspaceRole =
  | 'Owner'
  | 'Admin'
  | 'Designer'
  | 'Data Editor'
  | 'Viewer';

export type EnvironmentKind =
  | 'development'
  | 'staging'
  | 'production'
  | 'sandbox';

export type ConnectionMethod =
  | 'direct_tls'
  | 'azure_sql'
  | 'windows_agent'
  | 'local_sandbox';

export type AuthMethod =
  | 'sql_auth'
  | 'entra_id'
  | 'windows_integrated'
  | 'sandbox_local';

export type PlanTier = 'free' | 'pro' | 'team' | 'enterprise';

export type FriendlyFieldType =
  | 'auto_id'
  | 'text'
  | 'long_text'
  | 'integer'
  | 'decimal'
  | 'money'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'uuid';

export interface FieldTypeMapping {
  friendlyType: FriendlyFieldType;
  label: string;
  description: string;
  tsqlType: string;
  supportsLength?: boolean;
  supportsPrecision?: boolean;
  defaultLength?: number;
  defaultPrecision?: number;
  defaultScale?: number;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface AuthSessionInfo {
  authenticated: boolean;
  user: AuthUser | null;
  demoMode: boolean;
}

export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  tokenPreview: string;
  status: 'pending' | 'accepted' | 'revoked';
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
}

export interface BillingCheckoutSession {
  id: string;
  workspaceId: string;
  targetTier: PlanTier;
  provider: 'stripe_compatible' | 'manual_invoice';
  status: 'pending' | 'completed';
  checkoutUrl: string | null;
  note: string;
  createdAt: string;
}

export interface WorkspaceMember {
  id: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  schemaWrite: boolean;
  dataWrite: boolean;
  mfaEnabled: boolean;
  status: 'active' | 'suspended';
  joinedAt: string;
}

export interface WorkspacePolicy {
  requireApprovalForProduction: boolean;
  separationOfDuties: boolean;
  requireMfaForPrivileged: boolean;
  aiAssistantEnabled: boolean;
  aiSchemaSharingConsent: boolean;
  maxExportRows: number;
}

export interface SubscriptionInfo {
  tier: PlanTier;
  name: string;
  monthlyPriceUsd: number | null;
  seatsIncluded: number;
  seatsUsed: number;
  connectionsLimit: number;
  connectionsUsed: number;
  approvalsEnabled: boolean;
  auditRetentionDays: number;
  status: 'active' | 'trialing' | 'past_due';
}

export interface WorkspaceSummary {
  id: string;
  organizationName: string;
  name: string;
  region: string;
  policy: WorkspacePolicy;
  subscription: SubscriptionInfo;
  currentActor: WorkspaceMember;
  members: WorkspaceMember[];
}

export interface ConnectionCapabilities {
  canReadMetadata: boolean;
  canReadData: boolean;
  canWriteData: boolean;
  canModifySchema: boolean;
}

export interface ConnectionDiagnosticStep {
  step: 'reachability' | 'tls' | 'authentication' | 'permissions';
  label: string;
  status: 'passed' | 'failed' | 'skipped';
  detail: string;
  durationMs: number;
}

export interface DiscoveredSqlInstance {
  id: string;
  serverName: string;
  instanceName: string;
  fullTarget: string;
  port: number | null;
  version: string;
  serviceName?: string;
  serviceStatus: 'Running' | 'Stopped' | 'Unknown';
  availability: 'available' | 'stopped' | 'unreachable' | 'unknown';
  isDefaultInstance: boolean;
  isClustered?: boolean;
  source: 'windows_service' | 'windows_registry' | 'sql_browser_udp' | 'agent_probe';
}

export interface LocalDiscoveryResponse {
  supported: boolean;
  hostPlatform: string;
  viaAgentId: string | null;
  viaAgentName: string | null;
  instances: DiscoveredSqlInstance[];
  message: string;
  checkedAt: string;
}

export interface ConnectionProfile {
  id: string;
  workspaceId: string;
  name: string;
  method: ConnectionMethod;
  host: string;
  instanceName?: string | null;
  port: number;
  database: string;
  authMethod: AuthMethod;
  username: string;
  domain?: string | null;
  encrypt: boolean;
  trustServerCertificate: boolean;
  readOnly: boolean;
  timeoutMs: number;
  reconnectOnStartup: boolean;
  environment: EnvironmentKind;
  status: 'connected' | 'degraded' | 'disconnected' | 'error';
  engineVersion: string;
  lastCheckedAt: string;
  lastError?: string | null;
  capabilities: ConnectionCapabilities;
  agentId?: string | null;
}

export interface DatabaseInfo {
  name: string;
  stateDesc: string;
  recoveryModel: string;
  compatibilityLevel: number;
  collationName: string;
  sizeMb: number;
  createDate: string;
  isReadOnly: boolean;
  isSystem: boolean;
  ownerName?: string;
}

export interface TableDependency {
  direction: 'referencing' | 'referenced' | 'view';
  objectName: string;
  objectType: 'TABLE' | 'VIEW' | 'FOREIGN_KEY';
  constraintName?: string;
  detail: string;
}

export interface ColumnSchema {
  name: string;
  friendlyType: FriendlyFieldType;
  sqlType: string;
  maxLength?: number | null;
  precision?: number | null;
  scale?: number | null;
  nullable: boolean;
  isPrimaryKey: boolean;
  isIdentity: boolean;
  isUnique: boolean;
  defaultValue?: string | null;
  ordinalPosition: number;
}

export interface ForeignKeySchema {
  name: string;
  sourceSchema: string;
  sourceTable: string;
  sourceColumn: string;
  targetSchema: string;
  targetTable: string;
  targetColumn: string;
  onDelete: 'NO ACTION' | 'CASCADE' | 'SET NULL';
  onUpdate: 'NO ACTION' | 'CASCADE';
}

export interface IndexSchema {
  name: string;
  tableName: string;
  schemaName: string;
  columns: string[];
  isUnique: boolean;
  isPrimaryKey: boolean;
  type: 'CLUSTERED' | 'NONCLUSTERED';
}

export interface TableSchema {
  schemaName: string;
  tableName: string;
  fullName: string;
  objectType: 'TABLE' | 'VIEW';
  rowCountEstimate: number;
  hasStablePrimaryKey: boolean;
  primaryKeyColumns: string[];
  hasRowVersion: boolean;
  columns: ColumnSchema[];
  foreignKeys: ForeignKeySchema[];
  indexes: IndexSchema[];
}

export interface SchemaSnapshot {
  connectionId: string;
  databaseName: string;
  engineVersion: string;
  capturedAt: string;
  fingerprint: string;
  schemas: string[];
  tables: TableSchema[];
}

export interface FieldDraft {
  id: string;
  name: string;
  friendlyType: FriendlyFieldType;
  length?: number;
  precision?: number;
  scale?: number;
  nullable: boolean;
  isPrimaryKey: boolean;
  isIdentity: boolean;
  isUnique: boolean;
  defaultValue?: string;
}

export type SchemaOperation =
  | {
      kind: 'CREATE_TABLE';
      schemaName: string;
      tableName: string;
      description?: string;
      fields: FieldDraft[];
    }
  | {
      kind: 'ADD_COLUMN';
      schemaName: string;
      tableName: string;
      field: FieldDraft;
    }
  | {
      kind: 'ALTER_COLUMN';
      schemaName: string;
      tableName: string;
      columnName: string;
      friendlyType: FriendlyFieldType;
      length?: number;
      precision?: number;
      scale?: number;
      nullable: boolean;
    }
  | {
      kind: 'DROP_COLUMN';
      schemaName: string;
      tableName: string;
      columnName: string;
    }
  | {
      kind: 'DROP_TABLE';
      schemaName: string;
      tableName: string;
    }
  | {
      kind: 'ADD_FOREIGN_KEY';
      constraintName: string;
      sourceSchema: string;
      sourceTable: string;
      sourceColumn: string;
      targetSchema: string;
      targetTable: string;
      targetColumn: string;
      onDelete: 'NO ACTION' | 'CASCADE' | 'SET NULL';
      onUpdate: 'NO ACTION' | 'CASCADE';
    }
  | {
      kind: 'DROP_FOREIGN_KEY';
      constraintName: string;
      schemaName: string;
      tableName: string;
    }
  | {
      kind: 'ADD_UNIQUE_CONSTRAINT';
      constraintName: string;
      schemaName: string;
      tableName: string;
      columns: string[];
    }
  | {
      kind: 'ADD_PRIMARY_KEY';
      constraintName: string;
      schemaName: string;
      tableName: string;
      columns: string[];
    }
  | {
      kind: 'DROP_CONSTRAINT';
      constraintName: string;
      schemaName: string;
      tableName: string;
    }
  | {
      kind: 'CREATE_INDEX';
      indexName: string;
      schemaName: string;
      tableName: string;
      columns: string[];
      isUnique: boolean;
    }
  | {
      kind: 'DROP_INDEX';
      indexName: string;
      schemaName: string;
      tableName: string;
    }
  | {
      kind: 'RENAME_OBJECT';
      schemaName: string;
      tableName: string;
      columnName?: string;
      newName: string;
    }
  | {
      kind: 'CREATE_DATABASE';
      databaseName: string;
      collation?: string;
    };

export type RiskLevel = 'low' | 'medium' | 'high' | 'destructive';

export type ChangePlanStatus =
  | 'draft'
  | 'validated'
  | 'pending_approval'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'unknown';

export interface PreflightReport {
  passed: boolean;
  checks: Array<{
    name: string;
    status: 'pass' | 'warn' | 'fail';
    detail: string;
  }>;
  warnings: string[];
  requiredPermissions: string[];
  estimatedImpact: string;
}

export interface ChangePlan {
  id: string;
  workspaceId: string;
  connectionId: string;
  connectionName: string;
  environment: EnvironmentKind;
  title: string;
  plainExplanation: string;
  operations: SchemaOperation[];
  sqlPreview: string;
  riskLevel: RiskLevel;
  requiresConfirmText?: string | null;
  requiresApproval: boolean;
  status: ChangePlanStatus;
  targetFingerprint: string;
  digest: string;
  preflight: PreflightReport;
  createdById: string;
  createdByName: string;
  approvedById?: string | null;
  approvedByName?: string | null;
  createdAt: string;
  executedAt?: string | null;
  executionSummary?: string | null;
  errorMessage?: string | null;
}

export interface SchemaDriftReport {
  drifted: boolean;
  targetFingerprint: string;
  liveFingerprint: string;
  checkedAt: string;
  addedTables: string[];
  removedTables: string[];
  changedTables: Array<{
    fullName: string;
    addedColumns: string[];
    removedColumns: string[];
    alteredColumns: string[];
  }>;
  summary: string;
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  correlationId: string;
  actorId: string;
  actorName: string;
  actorRole: WorkspaceRole;
  action: string;
  resourceType:
    | 'connection'
    | 'database'
    | 'schema_plan'
    | 'record'
    | 'query'
    | 'agent'
    | 'policy'
    | 'billing'
    | 'auth';
  target: string;
  databaseName?: string | null;
  status: 'succeeded' | 'denied' | 'failed';
  detail: string;
  timestamp: string;
}

export interface RecordColumnFilter {
  id: string;
  column: string;
  operator: 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'is_null' | 'is_not_null';
  value: string;
}

export interface VisualQueryFilter {
  id: string;
  column: string;
  operator: 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'is_null' | 'is_not_null';
  value: string;
}

export interface VisualQueryJoin {
  id: string;
  joinType: 'INNER' | 'LEFT';
  targetSchema: string;
  targetTable: string;
  sourceColumn: string;
  targetColumn: string;
}

export interface VisualQueryAggregate {
  func: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
  column: string;
  alias: string;
}

export interface VisualQuerySpec {
  schemaName: string;
  tableName: string;
  columns: string[];
  joins?: VisualQueryJoin[];
  filters: VisualQueryFilter[];
  groupBy?: string[];
  aggregates?: VisualQueryAggregate[];
  orderBy?: {
    column: string;
    direction: 'ASC' | 'DESC';
  } | null;
  limit: number;
}

export interface QueryExecutionResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
  sqlExecuted: string;
  truncated: boolean;
  statementType: 'SELECT' | 'EXPLAIN' | 'MUTATION';
}

export interface SqlErrorExplanation {
  code: number | null;
  title: string;
  summary: string;
  suggestion: string;
}

export interface DiagramNodePosition {
  tableKey: string;
  x: number;
  y: number;
  group?: string;
}

export interface WindowsAgentRecord {
  id: string;
  workspaceId: string;
  name: string;
  hostname: string;
  version: string;
  status: 'online' | 'offline' | 'pending_approval' | 'revoked';
  lastHeartbeatAt: string | null;
  pairingTokenPreview: string;
  createdAt: string;
  osInfo?: string | null;
  discoveredInstancesCount?: number;
}

export interface AgentRpcRequest {
  type: 'rpc_request';
  requestId: string;
  method:
    | 'discover_instances'
    | 'test_connection'
    | 'list_databases'
    | 'get_database_properties'
    | 'create_database'
    | 'rename_object'
    | 'introspect'
    | 'get_dependencies'
    | 'browse_rows'
    | 'insert_row'
    | 'update_row'
    | 'delete_rows'
    | 'bulk_update'
    | 'execute_query'
    | 'apply_operations';
  payload: Record<string, unknown>;
}

export interface AgentRpcResponse {
  type: 'rpc_response';
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface AiSchemaProposal {
  summary: string;
  plainExplanation: string;
  tables: Array<{
    schemaName: string;
    tableName: string;
    purpose: string;
    fields: FieldDraft[];
  }>;
  relationships: Array<{
    sourceTable: string;
    sourceColumn: string;
    targetTable: string;
    targetColumn: string;
    reason: string;
  }>;
}

export interface AiRelationshipSuggestion {
  sourceSchema: string;
  sourceTable: string;
  sourceColumn: string;
  targetSchema: string;
  targetTable: string;
  targetColumn: string;
  reason: string;
  confidence: 'high' | 'medium';
}
