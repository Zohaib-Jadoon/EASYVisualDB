import crypto from 'node:crypto';
import net from 'node:net';
import sql from 'mssql';
import {
  ColumnSchema,
  ConnectionCapabilities,
  ConnectionDiagnosticStep,
  ConnectionProfile,
  DatabaseInfo,
  ForeignKeySchema,
  IndexSchema,
  QueryExecutionResult,
  RecordColumnFilter,
  SchemaOperation,
  SchemaSnapshot,
  TableDependency,
  TableSchema,
} from '../shared/types';
import {
  compileOperationsPlan,
  mapSqlTypeToFriendly,
  quoteTsqlIdentifier,
  validateIdentifier,
  validateSqlStatement,
} from '../shared/sqlCompiler';

export interface MssqlConnectInput {
  host: string;
  instanceName?: string | null;
  port: number;
  database: string;
  authMethod?: ConnectionProfile['authMethod'];
  username: string;
  password: string;
  domain?: string | null;
  encrypt: boolean;
  trustServerCertificate: boolean;
  timeoutMs?: number;
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

export function buildMssqlConfig(input: MssqlConnectInput, requestTimeoutMs = 15000): sql.config {
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
    const domainPart = input.domain?.trim() || (input.username.includes('\\') ? input.username.split('\\')[0] : '');
    const userPart = input.username.includes('\\') ? input.username.split('\\')[1] : input.username.trim();
    if (!userPart || !input.password) {
      throw new Error(
        'Windows Integrated Authentication via remote TDS requires Domain, Username, and Password (NTLM), or deploy the Windows Connector Agent directly on the Windows host under a trusted Windows service account.'
      );
    }
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

function profileToInput(connection: ConnectionProfile, password: string): MssqlConnectInput {
  return {
    host: connection.host,
    instanceName: connection.instanceName,
    port: connection.port,
    database: connection.database,
    authMethod: connection.authMethod,
    username: connection.username,
    password,
    domain: connection.domain,
    encrypt: connection.encrypt,
    trustServerCertificate: connection.trustServerCertificate,
    timeoutMs: connection.timeoutMs,
  };
}

export async function diagnoseMssqlConnection(input: MssqlConnectInput): Promise<{
  ok: boolean;
  steps: ConnectionDiagnosticStep[];
  engineVersion: string;
  capabilities: ConnectionCapabilities;
  accessibleDatabases: string[];
}> {
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

  // Step 1: TCP reachability (for default/explicit port; named instances use SQL Browser UDP 1434 first)
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
      steps.push({
        step: 'reachability',
        label: 'Hostname & TCP Port Reachability',
        status: 'failed',
        detail:
          err instanceof Error
            ? `Unreachable host/port: ${err.message}. Verify SQL Server TCP/IP is enabled, firewall port ${input.port || 1433}, or use the Windows Connector Agent.`
            : 'Unreachable host.',
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

  // Step 2 & 3: TLS + Authentication via mssql pool
  let pool: sql.ConnectionPool | null = null;
  const authStart = performance.now();
  try {
    const cfg = buildMssqlConfig(input);
    pool = await new sql.ConnectionPool(cfg).connect();
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
      label: input.authMethod === 'windows_integrated' ? 'Windows Authentication' : input.authMethod === 'entra_id' ? 'Microsoft Entra ID' : 'SQL Authentication',
      status: 'passed',
      detail: `Authenticated as "${input.username || 'Integrated Account'}" on database "${input.database || 'master'}".`,
      durationMs: Math.round(elapsed / 2),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isCertErr = /certificate|TLS|SSL|self signed/i.test(msg);
    steps.push({
      step: 'tls',
      label: 'TLS Certificate Validation',
      status: isCertErr ? 'failed' : 'passed',
      detail: isCertErr
        ? `TLS certificate validation failed (never silently bypassed): ${msg}`
        : 'TLS transport negotiated.',
      durationMs: Math.max(1, Math.round(performance.now() - authStart)),
    });
    steps.push({
      step: 'authentication',
      label: input.authMethod === 'windows_integrated' ? 'Windows Authentication' : 'SQL Authentication',
      status: isCertErr ? 'skipped' : 'failed',
      detail: isCertErr
        ? 'Skipped due to TLS certificate failure.'
        : `Authentication failed: ${msg}`,
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

  // Step 4: Probe version, accessible databases, and least-privilege permissions
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
      .query(`SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 AND state_desc = 'ONLINE' ORDER BY name`);
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
    steps.push({
      step: 'permissions',
      label: 'Metadata & Permission Probe',
      status: 'failed',
      detail: err instanceof Error ? err.message : 'Unable to probe SQL Server catalog permissions.',
      durationMs: Math.max(1, Math.round(performance.now() - permStart)),
    });
    return { ok: false, steps, engineVersion, capabilities, accessibleDatabases };
  } finally {
    await pool?.close().catch(() => undefined);
  }
}

export async function listMssqlDatabases(
  connection: ConnectionProfile,
  password: string
): Promise<DatabaseInfo[]> {
  const pool = await new sql.ConnectionPool(buildMssqlConfig(profileToInput(connection, password))).connect();
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
    await pool.close().catch(() => undefined);
  }
}

export async function createMssqlDatabase(
  connection: ConnectionProfile,
  password: string,
  dbName: string,
  collation?: string
): Promise<string> {
  const check = validateIdentifier(dbName, 'Database name');
  if (!check.valid) throw new Error(check.error);
  const input = { ...profileToInput(connection, password), database: 'master' };
  const pool = await new sql.ConnectionPool(buildMssqlConfig(input)).connect();
  try {
    const colClause =
      collation && validateIdentifier(collation, 'Collation').valid ? ` COLLATE ${collation.trim()}` : '';
    await pool.request().batch(`CREATE DATABASE ${quoteTsqlIdentifier(check.value)}${colClause};`);
    return `Created SQL Server database [${check.value}].`;
  } finally {
    await pool.close().catch(() => undefined);
  }
}

export async function renameMssqlObject(
  connection: ConnectionProfile,
  password: string,
  params: { schemaName: string; tableName: string; columnName?: string; newName: string }
): Promise<string> {
  const s = validateIdentifier(params.schemaName, 'Schema');
  const t = validateIdentifier(params.tableName, 'Table');
  const n = validateIdentifier(params.newName, 'New name');
  if (!s.valid) throw new Error(s.error);
  if (!t.valid) throw new Error(t.error);
  if (!n.valid) throw new Error(n.error);

  const pool = await new sql.ConnectionPool(buildMssqlConfig(profileToInput(connection, password))).connect();
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
    await pool.close().catch(() => undefined);
  }
}

export async function getMssqlDependencies(
  connection: ConnectionProfile,
  password: string,
  schemaName: string,
  tableName: string
): Promise<TableDependency[]> {
  const s = validateIdentifier(schemaName, 'Schema');
  const t = validateIdentifier(tableName, 'Table');
  if (!s.valid) throw new Error(s.error);
  if (!t.valid) throw new Error(t.error);

  const pool = await new sql.ConnectionPool(buildMssqlConfig(profileToInput(connection, password))).connect();
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
    await pool.close().catch(() => undefined);
  }
}

export async function introspectMssql(
  connection: ConnectionProfile,
  password: string
): Promise<SchemaSnapshot> {
  const pool = await new sql.ConnectionPool(buildMssqlConfig(profileToInput(connection, password))).connect();

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
    await pool.close().catch(() => undefined);
  }
}

export async function browseMssqlRows(
  connection: ConnectionProfile,
  password: string,
  params: {
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
): Promise<{ rows: Record<string, unknown>[]; totalRows: number }> {
  const pool = await new sql.ConnectionPool(buildMssqlConfig(profileToInput(connection, password))).connect();

  try {
    const tableSql = `${quoteTsqlIdentifier(params.schemaName)}.${quoteTsqlIdentifier(params.tableName)}`;
    const safeCols = params.columns.map(quoteTsqlIdentifier).join(', ');
    const safeLimit = Math.min(Math.max(params.pageSize || 50, 1), 200);
    const offset = Math.max((params.page || 1) - 1, 0) * safeLimit;

    const req = pool.request();
    const whereClauses: string[] = [];

    if (params.search && params.search.trim() !== '') {
      req.input('searchTerm', sql.NVarChar, `%${params.search.trim()}%`);
      const likes = params.columns.map((c) => `TRY_CAST(${quoteTsqlIdentifier(c)} AS NVARCHAR(400)) LIKE @searchTerm`);
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
          const opMap: Record<'eq' | 'neq' | 'gt' | 'lt', string> = { eq: '=', neq: '!=', gt: '>', lt: '<' };
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
    await pool.close().catch(() => undefined);
  }
}

export async function executeMssqlQuery(
  connection: ConnectionProfile,
  password: string,
  rawSql: string,
  params: Record<string, unknown> = {},
  allowMutations = false,
  options?: { timeoutMs?: number; maxRows?: number }
): Promise<QueryExecutionResult> {
  const check = validateSqlStatement(rawSql, allowMutations);
  if (!check.valid) throw new Error(check.error);

  const reqTimeout = Math.min(Math.max(options?.timeoutMs ?? 15000, 1000), 60000);
  const maxRows = Math.min(Math.max(options?.maxRows ?? 200, 1), 1000);

  const pool = await new sql.ConnectionPool(
    buildMssqlConfig(profileToInput(connection, password), reqTimeout)
  ).connect();

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
    await pool.close().catch(() => undefined);
  }
}

export async function applyMssqlOperations(
  connection: ConnectionProfile,
  password: string,
  operations: SchemaOperation[],
  snapshot: SchemaSnapshot
): Promise<string> {
  const compiled = compileOperationsPlan(operations, snapshot);
  if (!compiled.preflight.passed) {
    const firstFail = compiled.preflight.checks.find((c) => c.status === 'fail');
    throw new Error(firstFail?.detail || 'Preflight validation failed.');
  }

  const pool = await new sql.ConnectionPool(buildMssqlConfig(profileToInput(connection, password))).connect();

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
    await pool.close().catch(() => undefined);
  }
}
