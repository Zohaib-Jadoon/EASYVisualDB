import {
  ConnectionCapabilities,
  ConnectionDiagnosticStep,
  ConnectionProfile,
  DatabaseInfo,
  QueryExecutionResult,
  RecordColumnFilter,
  SchemaOperation,
  SchemaSnapshot,
  TableDependency,
} from '../../shared/types';

export interface ConnectionTestInput {
  host: string;
  instanceName?: string | null;
  port: number;
  database: string;
  authMethod: ConnectionProfile['authMethod'];
  username: string;
  password: string;
  domain?: string | null;
  encrypt: boolean;
  trustServerCertificate: boolean;
  timeoutMs?: number;
  agentId?: string | null;
}

export interface ConnectionDiagnosticResult {
  ok: boolean;
  steps: ConnectionDiagnosticStep[];
  engineVersion: string;
  capabilities: ConnectionCapabilities;
  accessibleDatabases: string[];
}

export interface BrowseRowsInput {
  schemaName: string;
  tableName: string;
  page: number;
  pageSize: number;
  sortColumn?: string;
  sortDir?: 'ASC' | 'DESC';
  search?: string;
  filters?: RecordColumnFilter[];
  columns: string[];
}

export interface DatabaseAdapter {
  readonly kind: 'sql_server_direct' | 'sql_server_agent' | 'sqlite_sandbox';
  diagnose(input: ConnectionTestInput): Promise<ConnectionDiagnosticResult>;
  listDatabases(connection: ConnectionProfile, secret: string): Promise<DatabaseInfo[]>;
  getDatabaseProperties(connection: ConnectionProfile, secret: string, dbName: string): Promise<DatabaseInfo>;
  createDatabase(connection: ConnectionProfile, secret: string, dbName: string, collation?: string): Promise<string>;
  renameObject(
    connection: ConnectionProfile,
    secret: string,
    params: { schemaName: string; tableName: string; columnName?: string; newName: string }
  ): Promise<string>;
  introspect(connection: ConnectionProfile, secret: string): Promise<SchemaSnapshot>;
  getDependencies(
    connection: ConnectionProfile,
    secret: string,
    schemaName: string,
    tableName: string
  ): Promise<TableDependency[]>;
  browseRows(
    connection: ConnectionProfile,
    secret: string,
    params: BrowseRowsInput
  ): Promise<{ rows: Record<string, unknown>[]; totalRows: number }>;
  insertRow(
    connection: ConnectionProfile,
    secret: string,
    schemaName: string,
    tableName: string,
    values: Record<string, unknown>
  ): Promise<void>;
  updateRowWithConcurrency(
    connection: ConnectionProfile,
    secret: string,
    params: {
      schemaName: string;
      tableName: string;
      pkValues: Record<string, unknown>;
      updates: Record<string, unknown>;
      originalValues: Record<string, unknown>;
    }
  ): Promise<{ updatedCount: number }>;
  deleteRowsByPk(
    connection: ConnectionProfile,
    secret: string,
    schemaName: string,
    tableName: string,
    pkColumn: string,
    pkValues: Array<string | number>
  ): Promise<{ deletedCount: number }>;
  bulkUpdateRows(
    connection: ConnectionProfile,
    secret: string,
    params: {
      schemaName: string;
      tableName: string;
      pkColumn: string;
      pkValues: Array<string | number>;
      column: string;
      value: unknown;
    }
  ): Promise<{ updatedCount: number }>;
  executeQuery(
    connection: ConnectionProfile,
    secret: string,
    rawSql: string,
    params: Record<string, unknown> | unknown[],
    allowMutations: boolean,
    options?: { timeoutMs?: number; maxRows?: number }
  ): Promise<QueryExecutionResult>;
  applyOperations(
    connection: ConnectionProfile,
    secret: string,
    operations: SchemaOperation[],
    snapshot: SchemaSnapshot
  ): Promise<string>;
}
