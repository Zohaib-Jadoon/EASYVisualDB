import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import net from 'node:net';
import sql from 'mssql';
import {
  BrowseRowsInput,
  ConnectionDiagnosticResult,
  ConnectionTestInput,
  DatabaseAdapter,
} from '../../server/adapters/types';
import { discoverLocalWindowsSqlInstances } from '../../server/localDiscovery';
import {
  compileOperationsPlan,
  mapSqlTypeToFriendly,
  quoteTsqlIdentifier,
  validateIdentifier,
  validateSqlStatement,
} from '../../shared/sqlCompiler';
import {
  ColumnSchema,
  ConnectionCapabilities,
  ConnectionDiagnosticStep,
  ConnectionProfile,
  DatabaseInfo,
  ForeignKeySchema,
  IndexSchema,
  LocalDiscoveryResponse,
  QueryExecutionResult,
  SchemaOperation,
  SchemaSnapshot,
  SqlServerConnectionParams,
  SqlServerErrorCategory,
  SqlServerHealthReport,
  SqlServerInstanceMetadata,
  SqlServerServerMetadata,
  TableDependency,
  TableSchema,
  WindowsAuthDriverStatus,
} from '../../shared/types';

export type WindowsAuthCapabilityStatus = WindowsAuthDriverStatus;
export type SqlServerHealthStatus = SqlServerHealthReport;

export type {
  SqlServerConnectionParams,
  SqlServerErrorCategory,
  SqlServerHealthReport,
  SqlServerInstanceMetadata,
  SqlServerServerMetadata,
  WindowsAuthDriverStatus,
};

const optionalRequire = createRequire(import.meta.url);

export function inspectWindowsIntegratedDriverSupport(): WindowsAuthCapabilityStatus {
  if (process.platform !== 'win32') {
    return {
      platform: process.platform,
      nativeSspiAvailable: false,
      driverName: 'tedious-ntlm-only',
      odbcDriverHint: 'Microsoft ODBC Driver 18 for SQL Server (Windows only)',
      requiresExplicitCredentials: true,
      detail:
        'Passwordless Windows Integrated Security (SSPI/Kerberos) requires Windows x64 with msnodesqlv8 and Microsoft ODBC Driver 17/18 for SQL Server. Remote NTLM requires domain, username, and password.',
    };
  }

  try {
    optionalRequire.resolve('msnodesqlv8');
    return {
      platform: process.platform,
      nativeSspiAvailable: true,
      driverName: 'msnodesqlv8',
      odbcDriverHint: 'ODBC Driver 18 for SQL Server',
      requiresExplicitCredentials: false,
      detail:
        'Native Windows SSPI driver (msnodesqlv8) detected. Passwordless Windows Integrated Security is available when Microsoft ODBC Driver 17/18 is installed.',
    };
  } catch {
    return {
      platform: process.platform,
      nativeSspiAvailable: false,
      driverName: 'tedious-ntlm-only',
      odbcDriverHint: 'Microsoft ODBC Driver 18 for SQL Server + msnodesqlv8',
      requiresExplicitCredentials: true,
      detail:
        'Native SSPI addon (msnodesqlv8) is not compiled in this bundle. Enter Domain, Username, and Password for Windows NTLM authentication, or use SQL Server Authentication.',
    };
  }
}

export function classifySqlServerError(
  err: unknown,
  authMethod?: ConnectionProfile['authMethod']
): {
  category: NonNullable<SqlServerHealthStatus['errorCategory']>;
  message: string;
} {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (/enotfound|eai_again|getaddrinfo/i.test(lower)) {
    return {
      category: 'host_not_found',
      message: `Server not found: ${raw}. Verify the hostname or IP address and DNS resolution.`,
    };
  }
  if (/econnrefused|server was not found or was not accessible/i.test(lower)) {
    return {
      category: 'service_unavailable',
      message: `SQL Server service unavailable or TCP/IP disabled: ${raw}. Confirm the SQL Server service is running and TCP port 1433 (or instance port) is listening.`,
    };
  }
  if (/enetunreach|ehostunreach|blocked destination/i.test(lower)) {
    return {
      category: 'network_unreachable',
      message: `Network unreachable: ${raw}. Check VPN, firewall rules, or connect through the Windows Connector Agent.`,
    };
  }
  if (/etimedout|timed out|timeout/i.test(lower)) {
    return {
      category: 'connection_timeout',
      message: `Connection timeout: ${raw}. Check firewall ports and SQL Server responsiveness.`,
    };
  }
  if (/instance|browser|udp|1434/i.test(lower) && /fail|resolve|find|timeout/i.test(lower)) {
    return {
      category: 'named_instance_resolution_failed',
      message: `Named instance resolution failed: ${raw}. Ensure the SQL Server Browser service (UDP 1434) is running or specify the explicit TCP port.`,
    };
  }
  if (/certificate|tls|ssl|self signed|unable to verify/i.test(lower)) {
    return {
      category: 'tls_certificate_failed',
      message: `TLS certificate validation failed (never silently bypassed): ${raw}. Install a trusted CA certificate or explicitly enable "Trust Server Certificate" if connecting to a local dev self-signed instance.`,
    };
  }
  if (/login failed|18456|authentication|password|ntlm|kerberos|sspi/i.test(lower)) {
    return {
      category: 'authentication_failed',
      message:
        authMethod === 'windows_integrated'
          ? `Windows Authentication failed: ${raw}. Verify domain\\username and password (or ODBC/SSPI configuration).`
          : `Authentication failed: ${raw}. Verify SQL username, password, and authentication mode.`,
    };
  }
  if (/permission|denied|229|262|has_dbaccess/i.test(lower)) {
    return {
      category: 'insufficient_permissions',
      message: `Insufficient SQL Server permissions: ${raw}.`,
    };
  }
  if (/msnodesqlv8|odbc/i.test(lower)) {
    return {
      category: 'driver_missing',
      message: raw,
    };
  }
  return { category: 'unknown', message: raw };
}

function validateHostNotLinkLocal(host: string): void {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) throw new Error('Server host cannot be empty.');
  if (
    trimmed === '169.254.169.254' ||
    trimmed.startsWith('169.254.') ||
    trimmed === 'metadata.google.internal' ||
    trimmed === '0.0.0.0'
  ) {
    throw new Error('Blocked destination address: link-local metadata endpoints are prohibited.');
  }
}

async function testTcpReachability(host: string, port: number, timeoutMs = 4000): Promise<number> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out after ${timeoutMs}ms reaching ${host}:${port}.`));
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(Math.max(1, Math.round(performance.now() - started)));
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function buildSqlServerConfig(
  input: ConnectionTestInput,
  requestTimeoutMs = 15000
): sql.config {
  const rawHost = input.host.trim();
  let serverHost = rawHost;
  let instanceName = input.instanceName?.trim() || undefined;

  if (!instanceName && rawHost.includes('\\')) {
    const [h, inst] = rawHost.split('\\', 2);
    serverHost = h.trim();
    instanceName = inst?.trim() || undefined;
  }

  const baseOptions: sql.config['options'] = {
    encrypt: input.encrypt,
    trustServerCertificate: input.trustServerCertificate,
    enableArithAbort: true,
    ...(instanceName && instanceName.toUpperCase() !== 'MSSQLSERVER' ? { instanceName } : {}),
  };

  const config: sql.config = {
    server: serverHost,
    ...(instanceName && instanceName.toUpperCase() !== 'MSSQLSERVER' ? {} : { port: input.port || 1433 }),
    database: input.database.trim() || 'master',
    connectionTimeout: input.timeoutMs ?? 8000,
    requestTimeout: requestTimeoutMs,
    options: baseOptions,
  };

  if (input.authMethod === 'windows_integrated') {
    const hasExplicitCreds = Boolean(input.username.trim() && input.password);
    if (!hasExplicitCreds) {
      const sspiStatus = inspectWindowsIntegratedDriverSupport();
      if (!sspiStatus.nativeSspiAvailable) {
        throw new Error(
          `Passwordless Windows Integrated Security requires msnodesqlv8 + Microsoft ODBC Driver 17/18 on Windows (${sspiStatus.detail}). Do not fall back silently to SQL Authentication — supply Domain, Username, and Password for NTLM or install the ODBC driver.`
        );
      }
      // When msnodesqlv8 is compiled on Windows, Trusted_Connection can be configured cleanly
      throw new Error(
        'Native SSPI pool requires mssql/msnodesqlv8 runtime bridge; provide NTLM domain\\username + password or configure ODBC DSN.'
      );
    }
    const domainPart =
      input.domain?.trim() || (input.username.includes('\\') ? input.username.split('\\')[0] : '');
    const userPart = input.username.includes('\\')
      ? input.username.split('\\')[1]
      : input.username.trim();
    config.authentication = {
      type: 'ntlm',
      options: {
        domain: domainPart,
        userName: userPart,
        password: input.password,
      },
    };
  } else if (input.authMethod === 'entra_id') {
    config.authentication = {
      type: 'azure-active-directory-password',
      options: {
        userName: input.username.trim(),
        password: input.password,
        clientId: process.env.AZURE_CLIENT_ID || '',
        tenantId: process.env.AZURE_TENANT_ID || '',
      },
    };
  } else {
    config.user = input.username.trim();
    config.password = input.password;
  }

  return config;
}

function profileToTestInput(connection: ConnectionProfile, secret: string): ConnectionTestInput {
  return {
    host: connection.host,
    instanceName: connection.instanceName,
    port: connection.port,
    database: connection.database,
    authMethod: connection.authMethod,
    username: connection.username,
    password: secret,
    domain: connection.domain,
    encrypt: connection.encrypt,
    trustServerCertificate: connection.trustServerCertificate,
    timeoutMs: connection.timeoutMs,
    agentId: connection.agentId,
  };
}

export interface SqlServerAdapter extends DatabaseAdapter {
  readonly kind: 'sql_server_direct';
  testConnection(input: ConnectionTestInput): Promise<ConnectionDiagnosticResult>;
  listDatabases(connection: ConnectionProfile, secret: string): Promise<DatabaseInfo[]>;
  getSchema(connection: ConnectionProfile, secret: string): Promise<SchemaSnapshot>;
  executeQuery(
    connection: ConnectionProfile,
    secret: string,
    rawSql: string,
    params?: Record<string, unknown> | unknown[],
    allowMutations?: boolean,
    options?: { timeoutMs?: number; maxRows?: number }
  ): Promise<QueryExecutionResult>;
  checkHealth(connection: ConnectionProfile, secret: string): Promise<SqlServerHealthStatus>;
  discoverLocalInstances(): Promise<LocalDiscoveryResponse>;
  getWindowsAuthSupport(): WindowsAuthCapabilityStatus;
  closeAllPools(): Promise<void>;
}

/**
 * Abstract base class for Microsoft SQL Server adapters (direct TDS/mssql,
 * native Windows ODBC/SSPI, or Windows Connector Agent transport).
 * Completely separate from the optional SQLite learning sandbox (`SandboxAdapter`).
 */
export abstract class BaseSqlServerAdapter implements DatabaseAdapter {
  abstract readonly kind: 'sql_server_direct' | 'sql_server_agent';

  abstract testConnection(input: ConnectionTestInput): Promise<ConnectionDiagnosticResult>;
  abstract listDatabases(connection: ConnectionProfile, secret: string): Promise<DatabaseInfo[]>;
  abstract getSchema(connection: ConnectionProfile, secret: string): Promise<SchemaSnapshot>;
  abstract executeQuery(
    connection: ConnectionProfile,
    secret: string,
    rawSql: string,
    params?: Record<string, unknown> | unknown[],
    allowMutations?: boolean,
    options?: { timeoutMs?: number; maxRows?: number }
  ): Promise<QueryExecutionResult>;

  diagnose(input: ConnectionTestInput): Promise<ConnectionDiagnosticResult> {
    return this.testConnection(input);
  }

  introspect(connection: ConnectionProfile, secret: string): Promise<SchemaSnapshot> {
    return this.getSchema(connection, secret);
  }

  getWindowsAuthSupport(): WindowsAuthCapabilityStatus {
    return inspectWindowsIntegratedDriverSupport();
  }

  discoverLocalInstances(): Promise<LocalDiscoveryResponse> {
    return discoverLocalWindowsSqlInstances();
  }

  abstract getDatabaseProperties(
    connection: ConnectionProfile,
    secret: string,
    dbName: string
  ): Promise<DatabaseInfo>;
  abstract createDatabase(
    connection: ConnectionProfile,
    secret: string,
    dbName: string,
    collation?: string
  ): Promise<string>;
  abstract renameObject(
    connection: ConnectionProfile,
    secret: string,
    params: { schemaName: string; tableName: string; columnName?: string; newName: string }
  ): Promise<string>;
  abstract getDependencies(
    connection: ConnectionProfile,
    secret: string,
    schemaName: string,
    tableName: string
  ): Promise<TableDependency[]>;
  abstract browseRows(
    connection: ConnectionProfile,
    secret: string,
    params: BrowseRowsInput
  ): Promise<{ rows: Record<string, unknown>[]; totalRows: number }>;
  abstract insertRow(
    connection: ConnectionProfile,
    secret: string,
    schemaName: string,
    tableName: string,
    values: Record<string, unknown>
  ): Promise<void>;
  abstract updateRowWithConcurrency(
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
  abstract deleteRowsByPk(
    connection: ConnectionProfile,
    secret: string,
    schemaName: string,
    tableName: string,
    pkColumn: string,
    pkValues: Array<string | number>
  ): Promise<{ deletedCount: number }>;
  abstract bulkUpdateRows(
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
  abstract applyOperations(
    connection: ConnectionProfile,
    secret: string,
    operations: SchemaOperation[],
    snapshot: SchemaSnapshot
  ): Promise<string>;
  abstract checkHealth(connection: ConnectionProfile, secret: string): Promise<SqlServerHealthStatus>;
  abstract closeAllPools(): Promise<void>;
}

/**
 * Dedicated Microsoft SQL Server adapter (T-SQL via mssql/tedious).
 * Completely separate from the optional SQLite learning sandbox (`SandboxAdapter`).
 */
export class SqlServerAdapter extends BaseSqlServerAdapter implements SqlServerAdapter {
  readonly kind = 'sql_server_direct' as const;
  private activePools = new Set<sql.ConnectionPool>();

  private async openPool(
    input: ConnectionTestInput,
    requestTimeoutMs = 15000
  ): Promise<sql.ConnectionPool> {
    const cfg = buildSqlServerConfig(input, requestTimeoutMs);
    const pool = new sql.ConnectionPool(cfg);
    this.activePools.add(pool);
    try {
      await pool.connect();
      return pool;
    } catch (err) {
      this.activePools.delete(pool);
      await pool.close().catch(() => undefined);
      throw err;
    }
  }

  private async closePool(pool: sql.ConnectionPool | null): Promise<void> {
    if (!pool) return;
    this.activePools.delete(pool);
    await pool.close().catch(() => undefined);
  }

  async closeAllPools(): Promise<void> {
    const pools = Array.from(this.activePools);
    this.activePools.clear();
    await Promise.all(pools.map((p) => p.close().catch(() => undefined)));
  }

  getWindowsAuthSupport(): WindowsAuthCapabilityStatus {
    return inspectWindowsIntegratedDriverSupport();
  }

  async discoverLocalInstances(): Promise<LocalDiscoveryResponse> {
    return discoverLocalWindowsSqlInstances();
  }

  async checkHealth(
    connection: ConnectionProfile,
    secret: string
  ): Promise<SqlServerHealthStatus> {
    const started = performance.now();
    const diag = await this.diagnose(profileToTestInput(connection, secret));
    const latencyMs = Math.max(1, Math.round(performance.now() - started));
    const failedStep = diag.steps.find((s) => s.status === 'failed');

    if (diag.ok) {
      return {
        healthy: true,
        engineVersion: diag.engineVersion,
        latencyMs,
        serverName: connection.instanceName
          ? `${connection.host}\\${connection.instanceName}`
          : connection.host,
        databaseName: connection.database,
        capabilities: diag.capabilities,
        accessibleDatabases: diag.accessibleDatabases,
        detail: `Connected cleanly in ${latencyMs}ms.`,
        checkedAt: new Date().toISOString(),
      };
    }

    const classified = classifySqlServerError(
      new Error(failedStep?.detail || 'Connection health probe failed.'),
      connection.authMethod
    );
    return {
      healthy: false,
      engineVersion: diag.engineVersion,
      latencyMs,
      serverName: connection.host,
      databaseName: connection.database,
      capabilities: diag.capabilities,
      accessibleDatabases: diag.accessibleDatabases,
      errorCategory: classified.category,
      detail: classified.message,
      checkedAt: new Date().toISOString(),
    };
  }

  async testConnection(input: ConnectionTestInput): Promise<ConnectionDiagnosticResult> {
    return this.diagnose(input);
  }

  async diagnose(input: ConnectionTestInput): Promise<ConnectionDiagnosticResult> {
    const steps: ConnectionDiagnosticStep[] = [];
    let engineVersion = 'Unknown';
    let capabilities: ConnectionCapabilities = {
      canReadMetadata: false,
      canReadData: false,
      canWriteData: false,
      canModifySchema: false,
    };
    let accessibleDatabases: string[] = [];

    try {
      validateHostNotLinkLocal(input.host);
    } catch (err) {
      steps.push({
        step: 'reachability',
        label: 'Hostname & Network Guardrails',
        status: 'failed',
        detail: err instanceof Error ? err.message : 'Invalid destination host.',
        durationMs: 1,
      });
      return { ok: false, steps, engineVersion, capabilities, accessibleDatabases };
    }

    const hostOnly = input.host.includes('\\') ? input.host.split('\\', 2)[0] : input.host.trim();
    const hasNamedInstance = Boolean(input.instanceName?.trim() || input.host.includes('\\'));

    if (!hasNamedInstance) {
      try {
        const ms = await testTcpReachability(hostOnly, input.port || 1433, input.timeoutMs ?? 4000);
        steps.push({
          step: 'reachability',
          label: 'Hostname & TCP Port Reachability',
          status: 'passed',
          detail: `TCP handshake succeeded to ${hostOnly}:${input.port || 1433} in ${ms}ms.`,
          durationMs: ms,
        });
      } catch (err) {
        const classified = classifySqlServerError(err, input.authMethod);
        steps.push({
          step: 'reachability',
          label: 'Hostname & TCP Port Reachability',
          status: 'failed',
          detail: classified.message,
          durationMs: 1,
        });
        steps.push({
          step: 'tls',
          label: 'TLS Certificate Validation',
          status: 'skipped',
          detail: 'Skipped because host is unreachable.',
          durationMs: 0,
        });
        steps.push({
          step: 'authentication',
          label: input.authMethod === 'windows_integrated' ? 'Windows Authentication' : 'SQL Authentication',
          status: 'skipped',
          detail: 'Skipped because host is unreachable.',
          durationMs: 0,
        });
        steps.push({
          step: 'permissions',
          label: 'Metadata & Permission Probe',
          status: 'skipped',
          detail: 'Skipped because host is unreachable.',
          durationMs: 0,
        });
        return { ok: false, steps, engineVersion, capabilities, accessibleDatabases };
      }
    } else {
      steps.push({
        step: 'reachability',
        label: 'Named Instance & SQL Browser Lookup',
        status: 'passed',
        detail: `Resolving named instance "${input.instanceName || input.host.split('\\')[1]}" on "${hostOnly}" via SQL Server Browser.`,
        durationMs: 1,
      });
    }

    let pool: sql.ConnectionPool | null = null;
    const authStart = performance.now();
    try {
      pool = await this.openPool(input);
      const elapsed = Math.max(1, Math.round(performance.now() - authStart));
      steps.push({
        step: 'tls',
        label: 'TLS Certificate Validation',
        status: input.encrypt ? 'passed' : 'failed',
        detail: input.encrypt
          ? input.trustServerCertificate
            ? 'Encrypted TLS session established (explicit self-signed certificate trust enabled).'
            : 'Encrypted TLS session verified against trusted certificate chain.'
          : 'TLS encryption disabled — enable TLS encryption for production environments.',
        durationMs: Math.round(elapsed / 2),
      });
      steps.push({
        step: 'authentication',
        label:
          input.authMethod === 'windows_integrated'
            ? 'Windows Authentication (NTLM)'
            : input.authMethod === 'entra_id'
            ? 'Microsoft Entra ID'
            : 'SQL Authentication',
        status: 'passed',
        detail: `Authenticated as "${input.username || 'Integrated Account'}" on database "${input.database || 'master'}".`,
        durationMs: Math.round(elapsed / 2),
      });
    } catch (err) {
      const classified = classifySqlServerError(err, input.authMethod);
      const isCertErr = classified.category === 'tls_certificate_failed';
      steps.push({
        step: 'tls',
        label: 'TLS Certificate Validation',
        status: isCertErr ? 'failed' : 'passed',
        detail: isCertErr ? classified.message : 'TLS transport negotiated.',
        durationMs: Math.max(1, Math.round(performance.now() - authStart)),
      });
      steps.push({
        step: 'authentication',
        label:
          input.authMethod === 'windows_integrated'
            ? 'Windows Authentication'
            : input.authMethod === 'entra_id'
            ? 'Microsoft Entra ID'
            : 'SQL Authentication',
        status: isCertErr ? 'skipped' : 'failed',
        detail: isCertErr ? 'Skipped due to TLS certificate failure.' : classified.message,
        durationMs: 1,
      });
      steps.push({
        step: 'permissions',
        label: 'Metadata & Permission Probe',
        status: 'skipped',
        detail: 'Skipped because login failed.',
        durationMs: 0,
      });
      return { ok: false, steps, engineVersion, capabilities, accessibleDatabases };
    }

    const permStart = performance.now();
    try {
      const versionRes = await pool.request().query(`SELECT @@VERSION AS ver`);
      const rawVer = String(versionRes.recordset[0]?.ver ?? 'Microsoft SQL Server');
      engineVersion = rawVer.split('\n')[0].trim().slice(0, 80);

      const permsRes = await pool.request().query(`
        SELECT
          HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION') AS canViewDef,
          HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'SELECT') AS canSelect,
          HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT') AS canInsert,
          HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE') AS canUpdate,
          HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS canCreateTable,
          HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER') AS canAlter
      `);
      const p = permsRes.recordset[0] || {};
      capabilities = {
        canReadMetadata: Boolean(p.canViewDef ?? 1),
        canReadData: Boolean(p.canSelect ?? 1),
        canWriteData: Boolean(p.canInsert || p.canUpdate),
        canModifySchema: Boolean(p.canCreateTable || p.canAlter),
      };

      const dbListRes = await pool
        .request()
        .query(
          `SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 AND state_desc = 'ONLINE' ORDER BY name`
        );
      accessibleDatabases = dbListRes.recordset.map((r) => String(r.name));

      steps.push({
        step: 'permissions',
        label: 'Metadata & Permission Probe',
        status: 'passed',
        detail: `Found ${accessibleDatabases.length} accessible database(s). Privileges — Metadata: ${capabilities.canReadMetadata ? 'Yes' : 'No'}, Read: ${capabilities.canReadData ? 'Yes' : 'No'}, Write Data: ${capabilities.canWriteData ? 'Yes' : 'No'}, Schema DDL: ${capabilities.canModifySchema ? 'Yes' : 'No'}.`,
        durationMs: Math.max(1, Math.round(performance.now() - permStart)),
      });

      return { ok: true, steps, engineVersion, capabilities, accessibleDatabases };
    } catch (err) {
      const classified = classifySqlServerError(err, input.authMethod);
      steps.push({
        step: 'permissions',
        label: 'Metadata & Permission Probe',
        status: 'failed',
        detail: classified.message,
        durationMs: Math.max(1, Math.round(performance.now() - permStart)),
      });
      return { ok: false, steps, engineVersion, capabilities, accessibleDatabases };
    } finally {
      await this.closePool(pool);
    }
  }

  async listDatabases(connection: ConnectionProfile, secret: string): Promise<DatabaseInfo[]> {
    const pool = await this.openPool(profileToTestInput(connection, secret));
    try {
      const res = await pool.request().query(`
        SELECT
          d.name,
          d.state_desc AS stateDesc,
          d.recovery_model_desc AS recoveryModel,
          d.compatibility_level AS compatibilityLevel,
          ISNULL(d.collation_name, '') AS collationName,
          CONVERT(DECIMAL(12,2), ISNULL(SUM(mf.size) * 8.0 / 1024.0, 0)) AS sizeMb,
          CONVERT(VARCHAR(30), d.create_date, 126) AS createDate,
          d.is_read_only AS isReadOnly,
          CASE WHEN d.database_id <= 4 THEN 1 ELSE 0 END AS isSystem,
          ISNULL(SUSER_SNAME(d.owner_sid), '') AS ownerName
        FROM sys.databases d
        LEFT JOIN sys.master_files mf ON d.database_id = mf.database_id
        WHERE HAS_DBACCESS(d.name) = 1
        GROUP BY d.name, d.state_desc, d.recovery_model_desc, d.compatibility_level, d.collation_name, d.create_date, d.is_read_only, d.database_id, d.owner_sid
        ORDER BY isSystem ASC, d.name ASC
      `);
      return res.recordset.map((r) => ({
        name: String(r.name),
        stateDesc: String(r.stateDesc),
        recoveryModel: String(r.recoveryModel),
        compatibilityLevel: Number(r.compatibilityLevel),
        collationName: String(r.collationName),
        sizeMb: Number(r.sizeMb ?? 0),
        createDate: String(r.createDate),
        isReadOnly: Boolean(r.isReadOnly),
        isSystem: Boolean(r.isSystem),
        ownerName: r.ownerName ? String(r.ownerName) : undefined,
      }));
    } finally {
      await this.closePool(pool);
    }
  }

  async getDatabaseProperties(
    connection: ConnectionProfile,
    secret: string,
    dbName: string
  ): Promise<DatabaseInfo> {
    const list = await this.listDatabases(connection, secret);
    const found = list.find((d) => d.name.toLowerCase() === dbName.toLowerCase());
    if (!found) throw new Error(`Database "${dbName}" not found or inaccessible.`);
    return found;
  }

  async createDatabase(
    connection: ConnectionProfile,
    secret: string,
    dbName: string,
    collation?: string
  ): Promise<string> {
    const check = validateIdentifier(dbName, 'Database name');
    if (!check.valid) throw new Error(check.error);
    const pool = await this.openPool({ ...profileToTestInput(connection, secret), database: 'master' });
    try {
      const colClause =
        collation && validateIdentifier(collation, 'Collation').valid
          ? ` COLLATE ${collation.trim()}`
          : '';
      await pool.request().batch(`CREATE DATABASE ${quoteTsqlIdentifier(check.value)}${colClause};`);
      return `Created SQL Server database [${check.value}].`;
    } finally {
      await this.closePool(pool);
    }
  }

  async renameObject(
    connection: ConnectionProfile,
    secret: string,
    params: { schemaName: string; tableName: string; columnName?: string; newName: string }
  ): Promise<string> {
    const s = validateIdentifier(params.schemaName, 'Schema');
    const t = validateIdentifier(params.tableName, 'Table');
    const n = validateIdentifier(params.newName, 'New name');
    if (!s.valid) throw new Error(s.error);
    if (!t.valid) throw new Error(t.error);
    if (!n.valid) throw new Error(n.error);

    const pool = await this.openPool(profileToTestInput(connection, secret));
    try {
      const req = pool.request();
      if (params.columnName) {
        const c = validateIdentifier(params.columnName, 'Column');
        if (!c.valid) throw new Error(c.error);
        req.input('objname', sql.NVarChar, `${s.value}.${t.value}.${c.value}`);
        req.input('newname', sql.NVarChar, n.value);
        req.input('objtype', sql.NVarChar, 'COLUMN');
        await req.query(`EXEC sp_rename @objname = @objname, @newname = @newname, @objtype = @objtype;`);
        return `Renamed column ${s.value}.${t.value}.${c.value} to ${n.value}.`;
      }
      req.input('objname', sql.NVarChar, `${s.value}.${t.value}`);
      req.input('newname', sql.NVarChar, n.value);
      await req.query(`EXEC sp_rename @objname = @objname, @newname = @newname;`);
      return `Renamed table ${s.value}.${t.value} to ${s.value}.${n.value}.`;
    } finally {
      await this.closePool(pool);
    }
  }

  async getSchema(connection: ConnectionProfile, secret: string): Promise<SchemaSnapshot> {
    return this.introspectSchema(connection, secret);
  }

  async introspect(connection: ConnectionProfile, secret: string): Promise<SchemaSnapshot> {
    return this.introspectSchema(connection, secret);
  }

  async introspectSchema(connection: ConnectionProfile, secret: string): Promise<SchemaSnapshot> {
    const pool = await this.openPool(profileToTestInput(connection, secret));
    try {
      const tablesRes = await pool.request().query(`
        SELECT
          s.name AS schemaName,
          o.name AS tableName,
          o.type_desc AS objectType,
          ISNULL(SUM(p.rows), 0) AS rowCountEstimate
        FROM sys.objects o
        INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
        LEFT JOIN sys.partitions p ON o.object_id = p.object_id AND p.index_id IN (0, 1)
        WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
        GROUP BY s.name, o.name, o.type_desc
        ORDER BY s.name, o.name
      `);

      const colsRes = await pool.request().query(`
        SELECT
          s.name AS schemaName,
          o.name AS tableName,
          c.name AS columnName,
          ty.name AS typeName,
          c.max_length AS maxLength,
          c.precision AS precisionVal,
          c.scale AS scaleVal,
          c.is_nullable AS isNullable,
          c.is_identity AS isIdentity,
          c.column_id AS ordinalPosition,
          dc.definition AS defaultValue,
          CASE WHEN pkc.column_id IS NOT NULL THEN 1 ELSE 0 END AS isPrimaryKey,
          CASE WHEN uqc.column_id IS NOT NULL THEN 1 ELSE 0 END AS isUnique
        FROM sys.columns c
        INNER JOIN sys.objects o ON c.object_id = o.object_id
        INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
        INNER JOIN sys.types ty ON c.user_type_id = ty.user_type_id
        LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
        LEFT JOIN (
          SELECT ic.object_id, ic.column_id
          FROM sys.index_columns ic
          INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
          WHERE i.is_primary_key = 1
        ) pkc ON c.object_id = pkc.object_id AND c.column_id = pkc.column_id
        LEFT JOIN (
          SELECT ic.object_id, ic.column_id
          FROM sys.index_columns ic
          INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
          WHERE i.is_unique = 1 AND i.is_primary_key = 0
        ) uqc ON c.object_id = uqc.object_id AND c.column_id = uqc.column_id
        WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
        ORDER BY s.name, o.name, c.column_id
      `);

      const fkRes = await pool.request().query(`
        SELECT
          fk.name AS fkName,
          ss.name AS sourceSchema,
          so.name AS sourceTable,
          sc.name AS sourceColumn,
          ts.name AS targetSchema,
          tobj.name AS targetTable,
          tc.name AS targetColumn,
          fk.delete_referential_action_desc AS onDelete,
          fk.update_referential_action_desc AS onUpdate
        FROM sys.foreign_keys fk
        INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
        INNER JOIN sys.objects so ON fkc.parent_object_id = so.object_id
        INNER JOIN sys.schemas ss ON so.schema_id = ss.schema_id
        INNER JOIN sys.columns sc ON fkc.parent_object_id = sc.object_id AND fkc.parent_column_id = sc.column_id
        INNER JOIN sys.objects tobj ON fkc.referenced_object_id = tobj.object_id
        INNER JOIN sys.schemas ts ON tobj.schema_id = ts.schema_id
        INNER JOIN sys.columns tc ON fkc.referenced_object_id = tc.object_id AND fkc.referenced_column_id = tc.column_id
      `);

      const idxRes = await pool.request().query(`
        SELECT
          s.name AS schemaName,
          o.name AS tableName,
          i.name AS indexName,
          i.is_unique AS isUnique,
          i.is_primary_key AS isPrimaryKey,
          i.type_desc AS indexType,
          c.name AS columnName
        FROM sys.indexes i
        INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        INNER JOIN sys.objects o ON i.object_id = o.object_id
        INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
        WHERE o.type = 'U' AND i.name IS NOT NULL AND ic.is_included_column = 0
        ORDER BY s.name, o.name, i.name, ic.key_ordinal
      `);

      const tableMap = new Map<string, TableSchema>();
      const schemas = new Set<string>();

      for (const r of tablesRes.recordset) {
        const key = `${r.schemaName}.${r.tableName}`;
        schemas.add(String(r.schemaName));
        tableMap.set(key, {
          schemaName: String(r.schemaName),
          tableName: String(r.tableName),
          fullName: key,
          objectType: String(r.objectType) === 'VIEW' ? 'VIEW' : 'TABLE',
          rowCountEstimate: Number(r.rowCountEstimate ?? 0),
          hasStablePrimaryKey: false,
          primaryKeyColumns: [],
          hasRowVersion: false,
          columns: [],
          foreignKeys: [],
          indexes: [],
        });
      }

      for (const c of colsRes.recordset) {
        const key = `${c.schemaName}.${c.tableName}`;
        const tbl = tableMap.get(key);
        if (!tbl) continue;
        const typeName = String(c.typeName).toUpperCase();
        let formattedType = typeName;
        if (typeName.includes('CHAR')) {
          const len = c.maxLength === -1 ? 'MAX' : typeName.startsWith('N') ? Number(c.maxLength) / 2 : c.maxLength;
          formattedType = `${typeName}(${len})`;
        } else if (typeName === 'DECIMAL' || typeName === 'NUMERIC') {
          formattedType = `${typeName}(${c.precisionVal},${c.scaleVal})`;
        }
        if (c.isIdentity) formattedType += ' IDENTITY';
        if (typeName === 'ROWVERSION' || typeName === 'TIMESTAMP') tbl.hasRowVersion = true;

        const col: ColumnSchema = {
          name: String(c.columnName),
          friendlyType: mapSqlTypeToFriendly(formattedType, Boolean(c.isIdentity)),
          sqlType: formattedType,
          maxLength: c.maxLength ? Number(c.maxLength) : null,
          precision: c.precisionVal ? Number(c.precisionVal) : null,
          scale: c.scaleVal ? Number(c.scaleVal) : null,
          nullable: Boolean(c.isNullable),
          isPrimaryKey: Boolean(c.isPrimaryKey),
          isIdentity: Boolean(c.isIdentity),
          isUnique: Boolean(c.isUnique),
          defaultValue: c.defaultValue ? String(c.defaultValue) : null,
          ordinalPosition: Number(c.ordinalPosition),
        };
        tbl.columns.push(col);
        if (col.isPrimaryKey) {
          tbl.primaryKeyColumns.push(col.name);
          tbl.hasStablePrimaryKey = true;
        }
      }

      for (const fk of fkRes.recordset) {
        const key = `${fk.sourceSchema}.${fk.sourceTable}`;
        const tbl = tableMap.get(key);
        if (!tbl) continue;
        const normAction = (v: string): ForeignKeySchema['onDelete'] =>
          v === 'CASCADE' ? 'CASCADE' : v === 'SET_NULL' ? 'SET NULL' : 'NO ACTION';
        tbl.foreignKeys.push({
          name: String(fk.fkName),
          sourceSchema: String(fk.sourceSchema),
          sourceTable: String(fk.sourceTable),
          sourceColumn: String(fk.sourceColumn),
          targetSchema: String(fk.targetSchema),
          targetTable: String(fk.targetTable),
          targetColumn: String(fk.targetColumn),
          onDelete: normAction(String(fk.onDelete)),
          onUpdate: String(fk.onUpdate) === 'CASCADE' ? 'CASCADE' : 'NO ACTION',
        });
      }

      const idxMap = new Map<string, IndexSchema>();
      for (const idx of idxRes.recordset) {
        const tableKey = `${idx.schemaName}.${idx.tableName}`;
        const idxKey = `${tableKey}.${idx.indexName}`;
        let entry = idxMap.get(idxKey);
        if (!entry) {
          entry = {
            name: String(idx.indexName),
            schemaName: String(idx.schemaName),
            tableName: String(idx.tableName),
            columns: [],
            isUnique: Boolean(idx.isUnique),
            isPrimaryKey: Boolean(idx.isPrimaryKey),
            type: String(idx.indexType) === 'CLUSTERED' ? 'CLUSTERED' : 'NONCLUSTERED',
          };
          idxMap.set(idxKey, entry);
          tableMap.get(tableKey)?.indexes.push(entry);
        }
        entry.columns.push(String(idx.columnName));
      }

      const tables = Array.from(tableMap.values());
      const fingerprint = crypto
        .createHash('sha256')
        .update(
          JSON.stringify(
            tables.map((t) => ({
              f: t.fullName,
              c: t.columns.map((c) => `${c.name}:${c.sqlType}:${c.nullable}`),
              fk: t.foreignKeys.map((fk) => `${fk.sourceColumn}->${fk.targetTable}.${fk.targetColumn}`),
            }))
          )
        )
        .digest('hex')
        .slice(0, 16);

      return {
        connectionId: connection.id,
        databaseName: connection.database,
        engineVersion: connection.engineVersion,
        capturedAt: new Date().toISOString(),
        fingerprint,
        schemas: Array.from(schemas),
        tables,
      };
    } finally {
      await this.closePool(pool);
    }
  }

  async getDependencies(
    connection: ConnectionProfile,
    secret: string,
    schemaName: string,
    tableName: string
  ): Promise<TableDependency[]> {
    const s = validateIdentifier(schemaName, 'Schema');
    const t = validateIdentifier(tableName, 'Table');
    if (!s.valid) throw new Error(s.error);
    if (!t.valid) throw new Error(t.error);

    const pool = await this.openPool(profileToTestInput(connection, secret));
    try {
      const req = pool.request();
      req.input('schemaName', sql.NVarChar, s.value);
      req.input('tableName', sql.NVarChar, t.value);

      const fkRes = await req.query(`
        SELECT
          fk.name AS constraintName,
          ss.name + '.' + so.name AS srcTable,
          sc.name AS srcCol,
          ts.name + '.' + tobj.name AS tgtTable,
          tc.name AS tgtCol,
          CASE WHEN ts.name = @schemaName AND tobj.name = @tableName THEN 'referencing' ELSE 'referenced' END AS dir
        FROM sys.foreign_keys fk
        INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
        INNER JOIN sys.objects so ON fkc.parent_object_id = so.object_id
        INNER JOIN sys.schemas ss ON so.schema_id = ss.schema_id
        INNER JOIN sys.columns sc ON fkc.parent_object_id = sc.object_id AND fkc.parent_column_id = sc.column_id
        INNER JOIN sys.objects tobj ON fkc.referenced_object_id = tobj.object_id
        INNER JOIN sys.schemas ts ON tobj.schema_id = ts.schema_id
        INNER JOIN sys.columns tc ON fkc.referenced_object_id = tc.object_id AND fkc.referenced_column_id = tc.column_id
        WHERE (ss.name = @schemaName AND so.name = @tableName)
           OR (ts.name = @schemaName AND tobj.name = @tableName)
      `);

      const viewRes = await req.query(`
        SELECT DISTINCT
          OBJECT_SCHEMA_NAME(d.referencing_id) + '.' + OBJECT_NAME(d.referencing_id) AS referencingObj,
          o.type_desc AS objType
        FROM sys.sql_expression_dependencies d
        INNER JOIN sys.objects o ON d.referencing_id = o.object_id
        WHERE d.referenced_id = OBJECT_ID(QUOTENAME(@schemaName) + '.' + QUOTENAME(@tableName))
      `);

      const deps: TableDependency[] = fkRes.recordset.map((r) => ({
        direction: r.dir === 'referencing' ? 'referencing' : 'referenced',
        objectName: r.dir === 'referencing' ? String(r.srcTable) : String(r.tgtTable),
        objectType: 'FOREIGN_KEY',
        constraintName: String(r.constraintName),
        detail: `${r.srcTable}.${r.srcCol} -> ${r.tgtTable}.${r.tgtCol}`,
      }));

      for (const vr of viewRes.recordset) {
        deps.push({
          direction: 'view',
          objectName: String(vr.referencingObj),
          objectType: String(vr.objType) === 'VIEW' ? 'VIEW' : 'TABLE',
          detail: `SQL expression dependency from ${vr.referencingObj}`,
        });
      }
      return deps;
    } finally {
      await this.closePool(pool);
    }
  }

  async browseRows(
    connection: ConnectionProfile,
    secret: string,
    params: BrowseRowsInput
  ): Promise<{ rows: Record<string, unknown>[]; totalRows: number }> {
    const pool = await this.openPool(profileToTestInput(connection, secret));
    try {
      const tableSql = `${quoteTsqlIdentifier(params.schemaName)}.${quoteTsqlIdentifier(params.tableName)}`;
      const safeCols = params.columns.map(quoteTsqlIdentifier).join(', ');
      const safeLimit = Math.min(Math.max(params.pageSize || 50, 1), 200);
      const offset = Math.max((params.page || 1) - 1, 0) * safeLimit;

      const req = pool.request();
      const whereClauses: string[] = [];

      if (params.search && params.search.trim() !== '') {
        req.input('searchTerm', sql.NVarChar, `%${params.search.trim()}%`);
        const likes = params.columns.map(
          (c) => `TRY_CAST(${quoteTsqlIdentifier(c)} AS NVARCHAR(400)) LIKE @searchTerm`
        );
        whereClauses.push(`(${likes.join(' OR ')})`);
      }

      if (params.filters && params.filters.length > 0) {
        params.filters.forEach((f, idx) => {
          const colSql = quoteTsqlIdentifier(f.column);
          const pName = `flt${idx}`;
          if (f.operator === 'is_null') whereClauses.push(`${colSql} IS NULL`);
          else if (f.operator === 'is_not_null') whereClauses.push(`${colSql} IS NOT NULL`);
          else if (f.operator === 'contains') {
            req.input(pName, sql.NVarChar, `%${f.value}%`);
            whereClauses.push(`TRY_CAST(${colSql} AS NVARCHAR(400)) LIKE @${pName}`);
          } else {
            const opMap: Record<'eq' | 'neq' | 'gt' | 'lt', string> = {
              eq: '=',
              neq: '!=',
              gt: '>',
              lt: '<',
            };
            req.input(pName, f.value);
            whereClauses.push(`${colSql} ${opMap[f.operator]} @${pName}`);
          }
        });
      }

      const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const orderCol =
        params.sortColumn && validateIdentifier(params.sortColumn).valid
          ? quoteTsqlIdentifier(params.sortColumn)
          : quoteTsqlIdentifier(params.columns[0]);
      const orderSql = `ORDER BY ${orderCol} ${params.sortDir === 'DESC' ? 'DESC' : 'ASC'}`;

      const cntRes = await req.query(`SELECT COUNT(*) AS total FROM ${tableSql} ${whereSql}`);
      const totalRows = Number(cntRes.recordset[0]?.total ?? 0);

      req.input('offsetVal', sql.Int, offset);
      req.input('limitVal', sql.Int, safeLimit);
      const rowsRes = await req.query(
        `SELECT ${safeCols} FROM ${tableSql} ${whereSql} ${orderSql} OFFSET @offsetVal ROWS FETCH NEXT @limitVal ROWS ONLY`
      );
      return { rows: rowsRes.recordset, totalRows };
    } finally {
      await this.closePool(pool);
    }
  }

  async insertRow(
    connection: ConnectionProfile,
    secret: string,
    schemaName: string,
    tableName: string,
    values: Record<string, unknown>
  ): Promise<void> {
    const keys = Object.keys(values);
    if (keys.length === 0) throw new Error('Provide at least one field value to insert.');
    const colsSql = keys.map(quoteTsqlIdentifier).join(', ');
    const paramRefs = keys.map((_k, i) => `@p${i}`).join(', ');
    const params: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      params[`p${i}`] = values[k];
    });
    await this.executeTSql(
      connection,
      secret,
      `INSERT INTO ${quoteTsqlIdentifier(schemaName)}.${quoteTsqlIdentifier(tableName)} (${colsSql}) VALUES (${paramRefs});`,
      params,
      true
    );
  }

  async updateRowWithConcurrency(
    connection: ConnectionProfile,
    secret: string,
    params: {
      schemaName: string;
      tableName: string;
      pkValues: Record<string, unknown>;
      updates: Record<string, unknown>;
      originalValues: Record<string, unknown>;
    }
  ): Promise<{ updatedCount: number }> {
    const updateKeys = Object.keys(params.updates);
    const pkKeys = Object.keys(params.pkValues);
    const sqlParams: Record<string, unknown> = {};
    let idx = 0;
    const setParts = updateKeys.map((k) => {
      const pname = `u${idx++}`;
      sqlParams[pname] = params.updates[k];
      return `${quoteTsqlIdentifier(k)} = @${pname}`;
    });
    const whereParts = pkKeys.map((k) => {
      const pname = `pk${idx++}`;
      sqlParams[pname] = params.pkValues[k];
      return `${quoteTsqlIdentifier(k)} = @${pname}`;
    });
    for (const k of updateKeys) {
      const orig = params.originalValues[k];
      if (orig === null || orig === undefined) {
        whereParts.push(`${quoteTsqlIdentifier(k)} IS NULL`);
      } else {
        const pname = `ov${idx++}`;
        sqlParams[pname] = orig;
        whereParts.push(`${quoteTsqlIdentifier(k)} = @${pname}`);
      }
    }
    const qRes = await this.executeTSql(
      connection,
      secret,
      `UPDATE ${quoteTsqlIdentifier(params.schemaName)}.${quoteTsqlIdentifier(params.tableName)} SET ${setParts.join(', ')} WHERE ${whereParts.join(' AND ')};`,
      sqlParams,
      true
    );
    return { updatedCount: qRes.rowCount };
  }

  async deleteRowsByPk(
    connection: ConnectionProfile,
    secret: string,
    schemaName: string,
    tableName: string,
    pkColumn: string,
    pkValues: Array<string | number>
  ): Promise<{ deletedCount: number }> {
    const params: Record<string, unknown> = {};
    const placeholders = pkValues.map((v, i) => {
      params[`d${i}`] = v;
      return `@d${i}`;
    });
    const qRes = await this.executeTSql(
      connection,
      secret,
      `DELETE FROM ${quoteTsqlIdentifier(schemaName)}.${quoteTsqlIdentifier(tableName)} WHERE ${quoteTsqlIdentifier(pkColumn)} IN (${placeholders.join(', ')});`,
      params,
      true
    );
    return { deletedCount: qRes.rowCount };
  }

  async bulkUpdateRows(
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
  ): Promise<{ updatedCount: number }> {
    const sqlParams: Record<string, unknown> = { val: params.value };
    const placeholders = params.pkValues.map((v, i) => {
      sqlParams[`pk${i}`] = v;
      return `@pk${i}`;
    });
    const qRes = await this.executeTSql(
      connection,
      secret,
      `UPDATE ${quoteTsqlIdentifier(params.schemaName)}.${quoteTsqlIdentifier(params.tableName)} SET ${quoteTsqlIdentifier(params.column)} = @val WHERE ${quoteTsqlIdentifier(params.pkColumn)} IN (${placeholders.join(', ')});`,
      sqlParams,
      true
    );
    return { updatedCount: qRes.rowCount };
  }

  executeQuery(
    connection: ConnectionProfile,
    secret: string,
    rawSql: string,
    params: Record<string, unknown> | unknown[] = {},
    allowMutations = false,
    options?: { timeoutMs?: number; maxRows?: number }
  ): Promise<QueryExecutionResult> {
    const namedParams = Array.isArray(params) ? {} : params;
    return this.executeTSql(connection, secret, rawSql, namedParams, allowMutations, options);
  }

  async executeTSql(
    connection: ConnectionProfile,
    secret: string,
    rawSql: string,
    params: Record<string, unknown> = {},
    allowMutations = false,
    options?: { timeoutMs?: number; maxRows?: number }
  ): Promise<QueryExecutionResult> {
    const check = validateSqlStatement(rawSql, allowMutations);
    if (!check.valid) throw new Error(check.error);

    const reqTimeout = Math.min(Math.max(options?.timeoutMs ?? 15000, 1000), 60000);
    const maxRows = Math.min(Math.max(options?.maxRows ?? 200, 1), 1000);

    const pool = await this.openPool(profileToTestInput(connection, secret), reqTimeout);
    try {
      const req = pool.request();
      for (const [k, v] of Object.entries(params)) {
        req.input(k, v);
      }
      const start = performance.now();
      const res = await req.query(rawSql);
      const rows = (res.recordset ?? []).slice(0, maxRows);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return {
        columns,
        rows,
        rowCount: rows.length || res.rowsAffected.reduce((a, b) => a + b, 0),
        durationMs: Math.max(1, Math.round(performance.now() - start)),
        sqlExecuted: rawSql,
        truncated: (res.recordset?.length ?? 0) > maxRows,
        statementType: check.statementType,
      };
    } finally {
      await this.closePool(pool);
    }
  }

  applyOperations(
    connection: ConnectionProfile,
    secret: string,
    operations: SchemaOperation[],
    snapshot: SchemaSnapshot
  ): Promise<string> {
    return this.applySchemaOperations(connection, secret, operations, snapshot);
  }

  async applySchemaOperations(
    connection: ConnectionProfile,
    secret: string,
    operations: SchemaOperation[],
    snapshot: SchemaSnapshot
  ): Promise<string> {
    const compiled = compileOperationsPlan(operations, snapshot);
    if (!compiled.preflight.passed) {
      const firstFail = compiled.preflight.checks.find((c) => c.status === 'fail');
      throw new Error(firstFail?.detail || 'Preflight validation failed.');
    }

    const pool = await this.openPool(profileToTestInput(connection, secret));
    const tx = new sql.Transaction(pool);
    try {
      await tx.begin();
      await tx.request().batch(compiled.tsql);
      await tx.commit();
      return `Executed ${operations.length} SQL Server DDL operation(s) cleanly in transaction.`;
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    } finally {
      await this.closePool(pool);
    }
  }
}

export const sqlServerAdapter = new SqlServerAdapter();
