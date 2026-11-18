import {
  ConnectionProfile,
  DatabaseInfo,
  QueryExecutionResult,
  SchemaOperation,
  SchemaSnapshot,
  TableDependency,
} from '../../shared/types';
import { agentGateway } from '../agentGateway';
import { BrowseRowsInput, ConnectionDiagnosticResult, ConnectionTestInput, DatabaseAdapter } from './types';

function requireAgent(connection: ConnectionProfile): { workspaceId: string; agentId: string } {
  if (!connection.agentId) {
    throw new Error('This Windows Agent connection does not have a paired agent assigned.');
  }
  return { workspaceId: connection.workspaceId, agentId: connection.agentId };
}

export const agentTunnelAdapter: DatabaseAdapter = {
  kind: 'sql_server_agent',

  async diagnose(input: ConnectionTestInput): Promise<ConnectionDiagnosticResult> {
    if (!input.agentId) {
      throw new Error('Select a paired online Windows Connector Agent before testing a private agent connection.');
    }
    // Note: workspaceId is passed via a helper on input or resolved in caller; for direct diagnose, caller sets agentId and calls callAgent
    throw new Error('Use diagnoseViaAgent(workspaceId, agentId, input) for Windows Agent diagnostics.');
  },

  listDatabases(connection: ConnectionProfile, secret: string): Promise<DatabaseInfo[]> {
    const { workspaceId, agentId } = requireAgent(connection);
    return agentGateway.callAgent<DatabaseInfo[]>(workspaceId, agentId, 'list_databases', {
      connection,
      secret,
    });
  },

  getDatabaseProperties(connection: ConnectionProfile, secret: string, dbName: string): Promise<DatabaseInfo> {
    const { workspaceId, agentId } = requireAgent(connection);
    return agentGateway.callAgent<DatabaseInfo>(workspaceId, agentId, 'get_database_properties', {
      connection,
      secret,
      dbName,
    });
  },

  createDatabase(connection: ConnectionProfile, secret: string, dbName: string, collation?: string): Promise<string> {
    const { workspaceId, agentId } = requireAgent(connection);
    return agentGateway.callAgent<string>(workspaceId, agentId, 'create_database', {
      connection,
      secret,
      dbName,
      collation,
    });
  },

  renameObject(
    connection: ConnectionProfile,
    secret: string,
    params: { schemaName: string; tableName: string; columnName?: string; newName: string }
  ): Promise<string> {
    const { workspaceId, agentId } = requireAgent(connection);
    return agentGateway.callAgent<string>(workspaceId, agentId, 'rename_object', {
      connection,
      secret,
      params,
    });
  },

  introspect(connection: ConnectionProfile, secret: string): Promise<SchemaSnapshot> {
    const { workspaceId, agentId } = requireAgent(connection);
    return agentGateway.callAgent<SchemaSnapshot>(workspaceId, agentId, 'introspect', {
      connection,
      secret,
    });
  },

  getDependencies(
    connection: ConnectionProfile,
    secret: string,
    schemaName: string,
    tableName: string
  ): Promise<TableDependency[]> {
    const { workspaceId, agentId } = requireAgent(connection);
    return agentGateway.callAgent<TableDependency[]>(workspaceId, agentId, 'get_dependencies', {
      connection,
      secret,
      schemaName,
      tableName,
    });
  },

  browseRows(connection: ConnectionProfile, secret: string, params: BrowseRowsInput) {
    const { workspaceId, agentId } = requireAgent(connection);
    return agentGateway.callAgent<{ rows: Record<string, unknown>[]; totalRows: number }>(
      workspaceId,
      agentId,
      'browse_rows',
      { connection, secret, params }
    );
  },

  async insertRow(connection, secret, schemaName, tableName, values): Promise<void> {
    const { workspaceId, agentId } = requireAgent(connection);
    await agentGateway.callAgent(workspaceId, agentId, 'insert_row', {
      connection,
      secret,
      schemaName,
      tableName,
      values,
    });
  },

  updateRowWithConcurrency(connection, secret, params): Promise<{ updatedCount: number }> {
    const { workspaceId, agentId } = requireAgent(connection);
    return agentGateway.callAgent<{ updatedCount: number }>(workspaceId, agentId, 'update_row', {
      connection,
      secret,
      params,
    });
  },

  deleteRowsByPk(connection, secret, schemaName, tableName, pkColumn, pkValues): Promise<{ deletedCount: number }> {
    const { workspaceId, agentId } = requireAgent(connection);
    return agentGateway.callAgent<{ deletedCount: number }>(workspaceId, agentId, 'delete_rows', {
      connection,
      secret,
      schemaName,
      tableName,
      pkColumn,
      pkValues,
    });
  },

  bulkUpdateRows(connection, secret, params): Promise<{ updatedCount: number }> {
    const { workspaceId, agentId } = requireAgent(connection);
    return agentGateway.callAgent<{ updatedCount: number }>(workspaceId, agentId, 'bulk_update', {
      connection,
      secret,
      params,
    });
  },

  executeQuery(connection, secret, rawSql, params, allowMutations, options): Promise<QueryExecutionResult> {
    const { workspaceId, agentId } = requireAgent(connection);
    return agentGateway.callAgent<QueryExecutionResult>(
      workspaceId,
      agentId,
      'execute_query',
      { connection, secret, rawSql, params, allowMutations, options },
      Math.max((options?.timeoutMs ?? 15000) + 5000, 20000)
    );
  },

  applyOperations(connection, secret, operations, snapshot): Promise<string> {
    const { workspaceId, agentId } = requireAgent(connection);
    return agentGateway.callAgent<string>(workspaceId, agentId, 'apply_operations', {
      connection,
      secret,
      operations,
      snapshot,
    });
  },
};

export function diagnoseViaAgent(
  workspaceId: string,
  agentId: string,
  input: ConnectionTestInput
): Promise<ConnectionDiagnosticResult> {
  return agentGateway.callAgent<ConnectionDiagnosticResult>(workspaceId, agentId, 'test_connection', {
    input,
  });
}
