import {
  ConnectionProfile,
  DatabaseInfo,
  QueryExecutionResult,
  SchemaOperation,
  SchemaSnapshot,
  TableDependency,
} from '../../shared/types';
import { sandboxDb } from '../sandboxDb';
import { BrowseRowsInput, ConnectionDiagnosticResult, ConnectionTestInput, DatabaseAdapter } from './types';

export const sandboxAdapter: DatabaseAdapter = {
  kind: 'sqlite_sandbox',

  async diagnose(_input: ConnectionTestInput): Promise<ConnectionDiagnosticResult> {
    return {
      ok: true,
      steps: [
        {
          step: 'reachability',
          label: 'Optional SQLite Learning Sandbox',
          status: 'passed',
          detail: 'Embedded local SQLite sandbox engine is active.',
          durationMs: 1,
        },
      ],
      engineVersion: 'Local SQL Sandbox (SQLite Learning Engine)',
      capabilities: {
        canReadMetadata: true,
        canReadData: true,
        canWriteData: true,
        canModifySchema: true,
      },
      accessibleDatabases: ['NorthwindOps_Sample'],
    };
  },

  async listDatabases(): Promise<DatabaseInfo[]> {
    return [
      {
        name: 'NorthwindOps_Sample',
        stateDesc: 'ONLINE',
        recoveryModel: 'SIMPLE (SQLite Sandbox)',
        compatibilityLevel: 160,
        collationName: 'BINARY (SQLite)',
        sizeMb: 0.4,
        createDate: new Date().toISOString(),
        isReadOnly: false,
        isSystem: false,
        ownerName: 'sandbox_explorer',
      },
    ];
  },

  async getDatabaseProperties(_conn, _secret, dbName): Promise<DatabaseInfo> {
    if (dbName !== 'NorthwindOps_Sample') {
      throw new Error(`Sandbox only hosts "NorthwindOps_Sample". Connect a real SQL Server instance for server-wide databases.`);
    }
    const list = await this.listDatabases(_conn, _secret);
    return list[0];
  },

  async createDatabase(): Promise<string> {
    throw new Error(
      'CREATE DATABASE is only available on real Microsoft SQL Server connections (not the optional SQLite sandbox).'
    );
  },

  async renameObject(_conn, _secret, params): Promise<string> {
    return sandboxDb.renameObject(params);
  },

  async introspect(connection: ConnectionProfile): Promise<SchemaSnapshot> {
    return sandboxDb.introspect(connection.id);
  },

  async getDependencies(_conn, _secret, schemaName, tableName): Promise<TableDependency[]> {
    return sandboxDb.getDependencies(schemaName, tableName);
  },

  async browseRows(_conn, _secret, params: BrowseRowsInput) {
    return sandboxDb.browseRows(params);
  },

  async insertRow(_conn, _secret, schemaName, tableName, values): Promise<void> {
    sandboxDb.insertRow(schemaName, tableName, values);
  },

  async updateRowWithConcurrency(_conn, _secret, params): Promise<{ updatedCount: number }> {
    return sandboxDb.updateRowWithConcurrency(params);
  },

  async deleteRowsByPk(_conn, _secret, schemaName, tableName, pkColumn, pkValues): Promise<{ deletedCount: number }> {
    return sandboxDb.deleteRowsByPk(schemaName, tableName, pkColumn, pkValues);
  },

  async bulkUpdateRows(_conn, _secret, params): Promise<{ updatedCount: number }> {
    return sandboxDb.bulkUpdateRows(params);
  },

  async executeQuery(
    _connection: ConnectionProfile,
    _secret: string,
    rawSql: string,
    params: Record<string, unknown> | unknown[],
    allowMutations: boolean,
    options?: { timeoutMs?: number; maxRows?: number }
  ): Promise<QueryExecutionResult> {
    const ordered = Array.isArray(params) ? params : [];
    const res = sandboxDb.executeQuery(rawSql, ordered, allowMutations);
    if (options?.maxRows && res.rows.length > options.maxRows) {
      return {
        ...res,
        rows: res.rows.slice(0, options.maxRows),
        rowCount: options.maxRows,
        truncated: true,
      };
    }
    return res;
  },

  async applyOperations(
    _connection: ConnectionProfile,
    _secret: string,
    operations: SchemaOperation[],
    snapshot: SchemaSnapshot
  ): Promise<string> {
    return sandboxDb.applyOperations(operations, snapshot);
  },
};
