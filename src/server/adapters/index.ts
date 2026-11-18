import { ConnectionProfile } from '../../shared/types';
import { agentTunnelAdapter, diagnoseViaAgent } from './agentTunnelAdapter';
import { mssqlAdapter } from './mssqlAdapter';
import { sandboxAdapter } from './sandboxAdapter';
import { DatabaseAdapter } from './types';

export type { BrowseRowsInput, ConnectionDiagnosticResult, ConnectionTestInput, DatabaseAdapter } from './types';
export { agentTunnelAdapter, diagnoseViaAgent, mssqlAdapter, sandboxAdapter };

export function getAdapterForConnection(connection: ConnectionProfile): DatabaseAdapter {
  if (connection.method === 'local_sandbox') {
    return sandboxAdapter;
  }
  if (connection.method === 'windows_agent') {
    return agentTunnelAdapter;
  }
  return mssqlAdapter;
}
