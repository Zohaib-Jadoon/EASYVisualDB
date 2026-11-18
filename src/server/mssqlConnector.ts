import crypto from 'node:crypto';
import net from 'node:net';
import sql from 'mssql';
import {
  ColumnSchema,
  ConnectionCapabilities,
  ConnectionDiagnosticStep,
  ConnectionProfile,
  ForeignKeySchema,
  IndexSchema,
  QueryExecutionResult,
  SchemaOperation,
  SchemaSnapshot,
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
  port: number;
  database: string;
  username: string;
  password: string;
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

function buildMssqlConfig(input: MssqlConnectInput): sql.config {
  return {
    server: input.host.trim(),
    port: input.port || 1433,
    database: input.database.trim(),
    user: input.username.trim(),
    password: input.password,
    connectionTimeout: input.timeoutMs ?? 8000,
    requestTimeout: 15000,
    options: {
      encrypt: input.encrypt,
      trustServerCertificate: input.trustServerCertificate,
      enableArithAbort: true,
    },
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

  // Step 1: TCP reachability
  try {
    const ms = await testTcpReachability(input.host.trim(), input.port || 1433);
    steps.push({
      step: 'reachability',
      label: 'Hostname & TCP Port Reachability',
      status: 'passed',
      detail: `TCP handshake succeeded to ${input.host}:${input.port || 1433} in ${ms}ms.`,
      durationMs: ms,
    });
  } catch (err) {
    steps.push({
      step: 'reachability',
      label: 'Hostname & TCP Port Reachability',
      status: 'failed',
      detail:
        err instanceof Error
          ? `Unreachable host/port: ${err.message}. Verify firewall rules or use the Windows Connector Agent for private networks.`
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
      label: 'SQL Authentication',
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

  // Step 2 & 3: TLS + Authentication via mssql pool
  let pool: sql.ConnectionPool | null = null;
  const authStart = performance.now();
  try {
    pool = await new sql.ConnectionPool(buildMssqlConfig(input)).connect();
    const elapsed = Math.max(1, Math.round(performance.now() - authStart));
    steps.push({
      step: 'tls',
      label: 'TLS Certificate Validation',
      status: input.encrypt ? 'passed' : 'failed',
      detail: input.encrypt
        ? input.trustServerCertificate
          ? 'Encrypted TLS session established (self-signed certificate override active).'
          : 'Encrypted TLS session verified against trusted certificate chain.'
        : 'TLS encryption disabled — encrypted transport is recommended for production.',
      durationMs: Math.round(elapsed / 2),
    });
    steps.push({
      step: 'authentication',
      label: 'SQL Authentication',
      status: 'passed',
      detail: `Authenticated as "${input.username}" on database "${input.database}".`,
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
        ? `TLS certificate validation failed: ${msg}`
        : 'TLS transport negotiated.',
      durationMs: Math.max(1, Math.round(performance.now() - authStart)),
    });
    steps.push({
      step: 'authentication',
      label: 'SQL Authentication',
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
      .query(`SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name`);
    accessibleDatabases = dbListRes.recordset.map((r) => String(r.name));

    steps.push({
      step: 'permissions',
      label: 'Metadata & Permission Probe',
      status: 'passed',
      detail: `Discovered permissions — Metadata: ${capabilities.canReadMetadata ? 'Yes' : 'No'}, Read: ${capabilities.canReadData ? 'Yes' : 'No'}, Write Data: ${capabilities.canWriteData ? 'Yes' : 'No'}, Schema DDL: ${capabilities.canModifySchema ? 'Yes' : 'No'}.`,
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

export async function introspectMssql(
  connection: ConnectionProfile,
  password: string
): Promise<SchemaSnapshot> {
  const pool = await new sql.ConnectionPool(
    buildMssqlConfig({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      username: connection.username,
      password,
      encrypt: connection.encrypt,
      trustServerCertificate: connection.trustServerCertificate,
    })
  ).connect();

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
    columns: string[];
  }
): Promise<{ rows: Record<string, unknown>[]; totalRows: number }> {
  const pool = await new sql.ConnectionPool(
    buildMssqlConfig({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      username: connection.username,
      password,
      encrypt: connection.encrypt,
      trustServerCertificate: connection.trustServerCertificate,
    })
  ).connect();

  try {
    const tableSql = `${quoteTsqlIdentifier(params.schemaName)}.${quoteTsqlIdentifier(params.tableName)}`;
    const safeCols = params.columns.map(quoteTsqlIdentifier).join(', ');
    const safeLimit = Math.min(Math.max(params.pageSize || 50, 1), 200);
    const offset = Math.max((params.page || 1) - 1, 0) * safeLimit;

    const req = pool.request();
    let whereSql = '';
    if (params.search && params.search.trim() !== '') {
      req.input('searchTerm', sql.NVarChar, `%${params.search.trim()}%`);
      const likes = params.columns.map((c) => `TRY_CAST(${quoteTsqlIdentifier(c)} AS NVARCHAR(400)) LIKE @searchTerm`);
      whereSql = `WHERE (${likes.join(' OR ')})`;
    }

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
  allowMutations = false
): Promise<QueryExecutionResult> {
  const check = validateSqlStatement(rawSql, allowMutations);
  if (!check.valid) throw new Error(check.error);

  const pool = await new sql.ConnectionPool(
    buildMssqlConfig({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      username: connection.username,
      password,
      encrypt: connection.encrypt,
      trustServerCertificate: connection.trustServerCertificate,
    })
  ).connect();

  try {
    const req = pool.request();
    for (const [k, v] of Object.entries(params)) {
      req.input(k, v);
    }
    const start = performance.now();
    const res = await req.query(rawSql);
    const rows = (res.recordset ?? []).slice(0, 200);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return {
      columns,
      rows,
      rowCount: rows.length || res.rowsAffected.reduce((a, b) => a + b, 0),
      durationMs: Math.max(1, Math.round(performance.now() - start)),
      sqlExecuted: rawSql,
      truncated: (res.recordset?.length ?? 0) > 200,
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

  const pool = await new sql.ConnectionPool(
    buildMssqlConfig({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      username: connection.username,
      password,
      encrypt: connection.encrypt,
      trustServerCertificate: connection.trustServerCertificate,
    })
  ).connect();

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
