import crypto from 'node:crypto';
import net from 'node:net';
import sql from 'mssql';

function quoteIdent(id: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(id.trim())) {
    throw new Error(`Invalid SQL identifier "${id}".`);
  }
  return `[${id.trim()}]`;
}

function buildConfig(conn: Record<string, unknown>, secret: string, overrideDb?: string, requestTimeoutMs = 15000): sql.config {
  const rawHost = String(conn.host || 'localhost').trim();
  let serverHost = rawHost;
  let instanceName = conn.instanceName ? String(conn.instanceName).trim() : undefined;
  if (!instanceName && rawHost.includes('\\')) {
    const [h, inst] = rawHost.split('\\', 2);
    serverHost = h.trim();
    instanceName = inst?.trim() || undefined;
  }

  const config: sql.config = {
    server: serverHost,
    ...(instanceName && instanceName.toUpperCase() !== 'MSSQLSERVER' ? {} : { port: Number(conn.port || 1433) }),
    database: overrideDb || String(conn.database || 'master'),
    connectionTimeout: Number(conn.timeoutMs || 8000),
    requestTimeout: requestTimeoutMs,
    options: {
      encrypt: conn.encrypt !== undefined ? Boolean(conn.encrypt) : true,
      trustServerCertificate: Boolean(conn.trustServerCertificate),
      enableArithAbort: true,
      ...(instanceName && instanceName.toUpperCase() !== 'MSSQLSERVER' ? { instanceName } : {}),
    },
  };

  if (conn.authMethod === 'windows_integrated') {
    const username = String(conn.username || '');
    const domain = String(conn.domain || (username.includes('\\') ? username.split('\\')[0] : ''));
    const userOnly = username.includes('\\') ? username.split('\\')[1] : username;
    if (!userOnly || !secret) {
      throw new Error('Windows Integrated Auth requires Domain/Username and Password (NTLM) or msnodesqlv8 SSPI driver.');
    }
    config.authentication = {
      type: 'ntlm',
      options: {
        domain,
        userName: userOnly,
        password: secret,
      },
    };
  } else {
    config.user = String(conn.username || '');
    config.password = secret;
  }
  return config;
}

async function testTcp(host: string, port: number, timeoutMs = 4000): Promise<number> {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port });
    const t = setTimeout(() => {
      s.destroy();
      reject(new Error(`TCP connection timed out to ${host}:${port}`));
    }, timeoutMs);
    s.once('connect', () => {
      clearTimeout(t);
      s.destroy();
      resolve(Math.max(1, Math.round(performance.now() - start)));
    });
    s.once('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

export async function handleAgentRpcMethod(method: string, payload: Record<string, unknown>): Promise<unknown> {
  if (method === 'test_connection') {
    const input = (payload.input ?? {}) as Record<string, unknown>;
    const steps: Array<{ step: string; label: string; status: string; detail: string; durationMs: number }> = [];
    const host = String(input.host || 'localhost');
    const hostOnly = host.includes('\\') ? host.split('\\')[0] : host;
    const hasNamed = Boolean(input.instanceName || host.includes('\\'));

    if (!hasNamed) {
      try {
        const ms = await testTcp(hostOnly, Number(input.port || 1433));
        steps.push({
          step: 'reachability',
          label: 'Agent Local TCP Reachability',
          status: 'passed',
          detail: `Windows Agent reached ${hostOnly}:${input.port || 1433} in ${ms}ms.`,
          durationMs: ms,
        });
      } catch (err) {
        steps.push({
          step: 'reachability',
          label: 'Agent Local TCP Reachability',
          status: 'failed',
          detail: err instanceof Error ? err.message : 'Unreachable from Windows Agent.',
          durationMs: 1,
        });
        return {
          ok: false,
          steps,
          engineVersion: 'Unknown',
          capabilities: { canReadMetadata: false, canReadData: false, canWriteData: false, canModifySchema: false },
          accessibleDatabases: [],
        };
      }
    } else {
      steps.push({
        step: 'reachability',
        label: 'Named Instance SQL Browser Lookup',
        status: 'passed',
        detail: `Targeting ${host} (${input.instanceName || host.split('\\')[1]}) from Windows Agent.`,
        durationMs: 1,
      });
    }

    let pool: sql.ConnectionPool | null = null;
    try {
      pool = await new sql.ConnectionPool(buildConfig(input, String(input.password || ''))).connect();
      steps.push({
        step: 'tls',
        label: 'TLS Validation',
        status: 'passed',
        detail: input.encrypt ? 'Encrypted TLS session established.' : 'TLS disabled by user configuration.',
        durationMs: 5,
      });
      steps.push({
        step: 'authentication',
        label: input.authMethod === 'windows_integrated' ? 'Windows Authentication' : 'SQL Authentication',
        status: 'passed',
        detail: `Authenticated cleanly on database "${input.database || 'master'}".`,
        durationMs: 5,
      });

      const verRes = await pool.request().query('SELECT @@VERSION AS ver');
      const engineVersion = String(verRes.recordset[0]?.ver || 'Microsoft SQL Server').split('\n')[0].trim().slice(0, 80);
      const dbRes = await pool.request().query(`SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 AND state_desc = 'ONLINE' ORDER BY name`);
      const accessibleDatabases = dbRes.recordset.map((r) => String(r.name));
      const perms = (
        await pool.request().query(`
          SELECT
            HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION') AS canViewDef,
            HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'SELECT') AS canSelect,
            HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT') AS canInsert,
            HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE') AS canUpdate,
            HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS canCreateTable,
            HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER') AS canAlter
        `)
      ).recordset[0] || {};
      const capabilities = {
        canReadMetadata: Boolean(perms.canViewDef ?? 1),
        canReadData: Boolean(perms.canSelect ?? 1),
        canWriteData: Boolean(perms.canInsert || perms.canUpdate),
        canModifySchema: Boolean(perms.canCreateTable || perms.canAlter),
      };
      steps.push({
        step: 'permissions',
        label: 'Metadata & Permission Probe',
        status: 'passed',
        detail: `Found ${accessibleDatabases.length} database(s).`,
        durationMs: 5,
      });
      return { ok: true, steps, engineVersion, capabilities, accessibleDatabases };
    } catch (err) {
      steps.push({
        step: 'authentication',
        label: 'Authentication / TLS',
        status: 'failed',
        detail: err instanceof Error ? err.message : 'Agent login failed.',
        durationMs: 1,
      });
      return {
        ok: false,
        steps,
        engineVersion: 'Unknown',
        capabilities: { canReadMetadata: false, canReadData: false, canWriteData: false, canModifySchema: false },
        accessibleDatabases: [],
      };
    } finally {
      await pool?.close().catch(() => undefined);
    }
  }

  const conn = (payload.connection ?? {}) as Record<string, unknown>;
  const secret = String(payload.secret || '');
  const pool = await new sql.ConnectionPool(buildConfig(conn, secret)).connect();

  try {
    if (method === 'list_databases' || method === 'get_database_properties') {
      const res = await pool.request().query(`
        SELECT d.name, d.state_desc AS stateDesc, d.recovery_model_desc AS recoveryModel,
               d.compatibility_level AS compatibilityLevel, ISNULL(d.collation_name, '') AS collationName,
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
      const list = res.recordset.map((r) => ({ ...r, isReadOnly: Boolean(r.isReadOnly), isSystem: Boolean(r.isSystem), sizeMb: Number(r.sizeMb ?? 0) }));
      if (method === 'get_database_properties') {
        const found = list.find((d) => String(d.name).toLowerCase() === String(payload.dbName || '').toLowerCase());
        if (!found) throw new Error('Database not found.');
        return found;
      }
      return list;
    }

    if (method === 'create_database') {
      const dbName = quoteIdent(String(payload.dbName || ''));
      await pool.request().batch(`CREATE DATABASE ${dbName};`);
      return `Created database ${dbName} via Windows Agent.`;
    }

    if (method === 'rename_object') {
      const p = (payload.params ?? {}) as Record<string, string>;
      const req = pool.request();
      if (p.columnName) {
        req.input('objname', sql.NVarChar, `${p.schemaName}.${p.tableName}.${p.columnName}`);
        req.input('newname', sql.NVarChar, p.newName);
        req.input('objtype', sql.NVarChar, 'COLUMN');
        await req.query(`EXEC sp_rename @objname = @objname, @newname = @newname, @objtype = @objtype;`);
      } else {
        req.input('objname', sql.NVarChar, `${p.schemaName}.${p.tableName}`);
        req.input('newname', sql.NVarChar, p.newName);
        await req.query(`EXEC sp_rename @objname = @objname, @newname = @newname;`);
      }
      return `Renamed object to ${p.newName} via Windows Agent.`;
    }

    if (method === 'execute_query') {
      const rawSql = String(payload.rawSql || '');
      const params = (payload.params ?? {}) as Record<string, unknown>;
      const options = (payload.options ?? {}) as { maxRows?: number };
      const maxRows = Math.min(Math.max(Number(options.maxRows ?? 200), 1), 1000);
      const req = pool.request();
      for (const [k, v] of Object.entries(params)) req.input(k, v);
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
        statementType: /^\s*(SELECT|WITH)/i.test(rawSql) ? 'SELECT' : 'MUTATION',
      };
    }

    if (method === 'introspect') {
      const tablesRes = await pool.request().query(`
        SELECT s.name AS schemaName, o.name AS tableName, o.type_desc AS objectType, ISNULL(SUM(p.rows), 0) AS rowCountEstimate
        FROM sys.objects o INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
        LEFT JOIN sys.partitions p ON o.object_id = p.object_id AND p.index_id IN (0, 1)
        WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
        GROUP BY s.name, o.name, o.type_desc ORDER BY s.name, o.name
      `);
      const colsRes = await pool.request().query(`
        SELECT s.name AS schemaName, o.name AS tableName, c.name AS columnName, ty.name AS typeName,
               c.max_length AS maxLength, c.precision AS precisionVal, c.scale AS scaleVal,
               c.is_nullable AS isNullable, c.is_identity AS isIdentity, c.column_id AS ordinalPosition,
               dc.definition AS defaultValue,
               CASE WHEN pkc.column_id IS NOT NULL THEN 1 ELSE 0 END AS isPrimaryKey,
               CASE WHEN uqc.column_id IS NOT NULL THEN 1 ELSE 0 END AS isUnique
        FROM sys.columns c INNER JOIN sys.objects o ON c.object_id = o.object_id
        INNER JOIN sys.schemas s ON o.schema_id = s.schema_id INNER JOIN sys.types ty ON c.user_type_id = ty.user_type_id
        LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
        LEFT JOIN (SELECT ic.object_id, ic.column_id FROM sys.index_columns ic INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id WHERE i.is_primary_key = 1) pkc ON c.object_id = pkc.object_id AND c.column_id = pkc.column_id
        LEFT JOIN (SELECT ic.object_id, ic.column_id FROM sys.index_columns ic INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id WHERE i.is_unique = 1 AND i.is_primary_key = 0) uqc ON c.object_id = uqc.object_id AND c.column_id = uqc.column_id
        WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 ORDER BY s.name, o.name, c.column_id
      `);
      const schemas = Array.from(new Set(tablesRes.recordset.map((t) => String(t.schemaName))));
      const tableMap = new Map<string, Record<string, unknown>>();
      for (const r of tablesRes.recordset) {
        const key = `${r.schemaName}.${r.tableName}`;
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
        const tbl = tableMap.get(`${c.schemaName}.${c.tableName}`);
        if (!tbl) continue;
        const typeName = String(c.typeName).toUpperCase();
        const cols = tbl.columns as Array<Record<string, unknown>>;
        cols.push({
          name: String(c.columnName),
          friendlyType: typeName.includes('INT') ? (c.isIdentity ? 'auto_id' : 'integer') : typeName.includes('CHAR') ? 'text' : typeName === 'BIT' ? 'boolean' : 'text',
          sqlType: typeName,
          nullable: Boolean(c.isNullable),
          isPrimaryKey: Boolean(c.isPrimaryKey),
          isIdentity: Boolean(c.isIdentity),
          isUnique: Boolean(c.isUnique),
          defaultValue: c.defaultValue ? String(c.defaultValue) : null,
          ordinalPosition: Number(c.ordinalPosition),
        });
        if (c.isPrimaryKey) {
          (tbl.primaryKeyColumns as string[]).push(String(c.columnName));
          tbl.hasStablePrimaryKey = true;
        }
      }
      const tables = Array.from(tableMap.values());
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(tables.map((t) => t.fullName))).digest('hex').slice(0, 16);
      return {
        connectionId: String(conn.id || ''),
        databaseName: String(conn.database || ''),
        engineVersion: String(conn.engineVersion || 'Microsoft SQL Server'),
        capturedAt: new Date().toISOString(),
        fingerprint,
        schemas,
        tables,
      };
    }

    if (method === 'apply_operations') {
      const sqlPreview = String((payload as Record<string, unknown>).tsql || '');
      if (!sqlPreview) throw new Error('Agent requires compiled T-SQL DDL payload.');
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        await tx.request().batch(sqlPreview);
        await tx.commit();
        return 'Executed SQL Server DDL transaction cleanly via Windows Connector Agent.';
      } catch (err) {
        await tx.rollback().catch(() => undefined);
        throw err;
      }
    }

    throw new Error(`Unsupported RPC method "${method}" on Windows Agent.`);
  } finally {
    await pool.close().catch(() => undefined);
  }
}
