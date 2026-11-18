import { sqlServerAdapter } from '../../lib/db/sqlserver';
import { DatabaseAdapter } from './types';

// Re-export the unified SqlServerAdapter from src/lib/db/sqlserver.ts
// so direct TCP/TLS, Named Instance, Azure SQL, and Desktop Electron backends
// share one canonical T-SQL adapter implementation.
export { SqlServerAdapter, sqlServerAdapter } from '../../lib/db/sqlserver';

export const mssqlAdapter: DatabaseAdapter = sqlServerAdapter;
