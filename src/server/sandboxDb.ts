import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ColumnSchema,
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
  quoteSqliteIdentifier,
  quoteSqliteQualifiedTable,
  validateIdentifier,
  validateSqlStatement,
} from '../shared/sqlCompiler';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SANDBOX_DB_PATH = path.join(DATA_DIR, 'sandbox-northwind.db');

export class SandboxDatabaseEngine {
  private db: DatabaseSync | null = null;

  private open(): DatabaseSync {
    if (this.db) return this.db;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.db = new DatabaseSync(SANDBOX_DB_PATH);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    return this.db;
  }

  ensureSeeded(): void {
    const db = this.open();
    const existing = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dbo.Departments'`)
      .get();
    if (existing) return;

    db.exec(`
      CREATE TABLE "dbo.Departments" (
        "DepartmentID" INTEGER PRIMARY KEY AUTOINCREMENT,
        "Code" TEXT NOT NULL UNIQUE,
        "Name" TEXT NOT NULL,
        "Budget" REAL NOT NULL DEFAULT 0,
        "IsActive" INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE "dbo.Employees" (
        "EmployeeID" INTEGER PRIMARY KEY AUTOINCREMENT,
        "DepartmentID" INTEGER NOT NULL,
        "FullName" TEXT NOT NULL,
        "Email" TEXT NOT NULL UNIQUE,
        "RoleTitle" TEXT NOT NULL,
        "Salary" REAL NOT NULL,
        "HireDate" TEXT NOT NULL,
        "IsActive" INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY ("DepartmentID") REFERENCES "dbo.Departments"("DepartmentID") ON DELETE NO ACTION ON UPDATE CASCADE
      );

      CREATE TABLE "dbo.Projects" (
        "ProjectID" INTEGER PRIMARY KEY AUTOINCREMENT,
        "DepartmentID" INTEGER NOT NULL,
        "LeadEmployeeID" INTEGER,
        "ProjectName" TEXT NOT NULL,
        "Status" TEXT NOT NULL DEFAULT 'Active',
        "Deadline" TEXT,
        "AllocatedBudget" REAL NOT NULL DEFAULT 0,
        FOREIGN KEY ("DepartmentID") REFERENCES "dbo.Departments"("DepartmentID") ON DELETE NO ACTION ON UPDATE CASCADE,
        FOREIGN KEY ("LeadEmployeeID") REFERENCES "dbo.Employees"("EmployeeID") ON DELETE SET NULL ON UPDATE CASCADE
      );

      CREATE TABLE "dbo.Tasks" (
        "TaskID" INTEGER PRIMARY KEY AUTOINCREMENT,
        "ProjectID" INTEGER NOT NULL,
        "AssigneeID" INTEGER,
        "Title" TEXT NOT NULL,
        "Priority" TEXT NOT NULL DEFAULT 'Normal',
        "EstimatedHours" REAL NOT NULL DEFAULT 4,
        "Completed" INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY ("ProjectID") REFERENCES "dbo.Projects"("ProjectID") ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY ("AssigneeID") REFERENCES "dbo.Employees"("EmployeeID") ON DELETE SET NULL ON UPDATE CASCADE
      );

      CREATE INDEX "IX_Employees_DepartmentID" ON "dbo.Employees" ("DepartmentID");
      CREATE INDEX "IX_Projects_Status" ON "dbo.Projects" ("Status");
      CREATE INDEX "IX_Tasks_ProjectID" ON "dbo.Tasks" ("ProjectID");

      INSERT INTO "dbo.Departments" ("Code", "Name", "Budget", "IsActive") VALUES
        ('ENG', 'Platform Engineering', 480000, 1),
        ('OPS', 'Cloud Operations', 310000, 1),
        ('FIN', 'Finance & Billing', 225000, 1),
        ('PRD', 'Product Design', 195000, 1);

      INSERT INTO "dbo.Employees" ("DepartmentID", "FullName", "Email", "RoleTitle", "Salary", "HireDate", "IsActive") VALUES
        (1, 'Amina Tariq', 'amina.tariq@company.example', 'Principal Architect', 142000, '2023-02-15', 1),
        (1, 'Hamza Siddiqui', 'hamza.s@company.example', 'Senior SQL Engineer', 124000, '2023-07-01', 1),
        (2, 'Usman Raza', 'usman.r@company.example', 'Site Reliability Lead', 118000, '2024-01-10', 1),
        (3, 'Fatima Noor', 'fatima.n@company.example', 'Financial Controller', 105000, '2022-11-20', 1),
        (4, 'Zoya Qureshi', 'zoya.q@company.example', 'Product Designer', 98000, '2024-05-06', 1),
        (1, 'Bilal Hassan', 'bilal.h@company.example', 'Backend Developer', 94000, '2025-01-12', 1);

      INSERT INTO "dbo.Projects" ("DepartmentID", "LeadEmployeeID", "ProjectName", "Status", "Deadline", "AllocatedBudget") VALUES
        (1, 1, 'SQL Server TLS Gateway', 'Active', '2026-12-20', 145000),
        (2, 3, 'On-Prem Windows Agent Rollout', 'Active', '2027-01-30', 92000),
        (4, 5, 'Visual ER Canvas v2', 'Planning', '2027-02-15', 64000),
        (3, 4, 'Multi-Currency Invoicing', 'Completed', '2026-10-01', 48000);

      INSERT INTO "dbo.Tasks" ("ProjectID", "AssigneeID", "Title", "Priority", "EstimatedHours", "Completed") VALUES
        (1, 2, 'Validate catalog view introspection', 'High', 16, 1),
        (1, 6, 'Implement parameterized query builder', 'High', 24, 0),
        (2, 3, 'Sign Windows Service installer', 'Normal', 12, 0),
        (3, 5, 'Refine table node contrast tokens', 'Normal', 8, 1);
    `);
  }

  introspect(connectionId: string): SchemaSnapshot {
    this.ensureSeeded();
    const db = this.open();

    const masterRows = db
      .prepare(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name ASC`
      )
      .all() as Array<{ name: string; type: 'table' | 'view' }>;

    const tables: TableSchema[] = [];
    const schemaSet = new Set<string>();

    for (const row of masterRows) {
      const rawName = row.name;
      const dotIdx = rawName.indexOf('.');
      const schemaName = dotIdx > 0 ? rawName.slice(0, dotIdx) : 'dbo';
      const tableName = dotIdx > 0 ? rawName.slice(dotIdx + 1) : rawName;
      schemaSet.add(schemaName);

      const escapedRaw = `"${rawName.replace(/"/g, '""')}"`;
      const pragmaCols = db.prepare(`PRAGMA table_info(${escapedRaw})`).all() as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      const pragmaFks = db.prepare(`PRAGMA foreign_key_list(${escapedRaw})`).all() as Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
      }>;

      const pragmaIdx = db.prepare(`PRAGMA index_list(${escapedRaw})`).all() as Array<{
        seq: number;
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }>;

      const uniqueSingleCols = new Set<string>();
      const indexes: IndexSchema[] = [];

      for (const idx of pragmaIdx) {
        const idxInfo = db
          .prepare(`PRAGMA index_info("${idx.name.replace(/"/g, '""')}")`)
          .all() as Array<{ seqno: number; cid: number; name: string }>;
        const cols = idxInfo.map((i) => i.name).filter(Boolean);
        if (idx.unique && cols.length === 1) {
          uniqueSingleCols.add(cols[0]);
        }
        indexes.push({
          name: idx.name,
          tableName,
          schemaName,
          columns: cols,
          isUnique: Boolean(idx.unique),
          isPrimaryKey: idx.origin === 'pk',
          type: idx.origin === 'pk' ? 'CLUSTERED' : 'NONCLUSTERED',
        });
      }

      const pkCols = pragmaCols
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);

      const columns: ColumnSchema[] = pragmaCols.map((c) => {
        const isPk = c.pk > 0;
        const upperType = (c.type || 'TEXT').toUpperCase();
        const isIdentity = isPk && upperType === 'INTEGER' && pkCols.length === 1;
        const sqlDisplayType = isIdentity
          ? 'INT IDENTITY(1,1)'
          : upperType === 'INTEGER'
          ? 'INT'
          : upperType === 'REAL'
          ? 'DECIMAL(18,2)'
          : 'NVARCHAR(255)';

        return {
          name: c.name,
          friendlyType: mapSqlTypeToFriendly(sqlDisplayType, isIdentity),
          sqlType: sqlDisplayType,
          nullable: c.notnull === 0 && !isPk,
          isPrimaryKey: isPk,
          isIdentity,
          isUnique: isPk || uniqueSingleCols.has(c.name),
          defaultValue: c.dflt_value,
          ordinalPosition: c.cid + 1,
        };
      });

      const foreignKeys: ForeignKeySchema[] = pragmaFks.map((fk, idx) => {
        const tgtDot = fk.table.indexOf('.');
        const targetSchema = tgtDot > 0 ? fk.table.slice(0, tgtDot) : 'dbo';
        const targetTable = tgtDot > 0 ? fk.table.slice(tgtDot + 1) : fk.table;
        return {
          name: `FK_${tableName}_${fk.from}_${idx + 1}`,
          sourceSchema: schemaName,
          sourceTable: tableName,
          sourceColumn: fk.from,
          targetSchema,
          targetTable,
          targetColumn: fk.to,
          onDelete: (fk.on_delete?.toUpperCase() as ForeignKeySchema['onDelete']) || 'NO ACTION',
          onUpdate: (fk.on_update?.toUpperCase() as ForeignKeySchema['onUpdate']) || 'NO ACTION',
        };
      });

      let rowCountEstimate = 0;
      try {
        const cnt = db.prepare(`SELECT COUNT(*) as c FROM ${escapedRaw}`).get() as { c: number };
        rowCountEstimate = cnt.c;
      } catch {
        rowCountEstimate = 0;
      }

      tables.push({
        schemaName,
        tableName,
        fullName: `${schemaName}.${tableName}`,
        objectType: row.type === 'view' ? 'VIEW' : 'TABLE',
        rowCountEstimate,
        hasStablePrimaryKey: pkCols.length > 0,
        primaryKeyColumns: pkCols,
        hasRowVersion: false,
        columns,
        foreignKeys,
        indexes,
      });
    }

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
      connectionId,
      databaseName: 'NorthwindOps_Sample',
      engineVersion: 'Local SQL Sandbox (SQL Server 2022 T-SQL Mode)',
      capturedAt: new Date().toISOString(),
      fingerprint,
      schemas: Array.from(schemaSet),
      tables,
    };
  }

  browseRows(params: {
    schemaName: string;
    tableName: string;
    page: number;
    pageSize: number;
    sortColumn?: string;
    sortDir?: 'ASC' | 'DESC';
    search?: string;
    columns: string[];
  }): { rows: Record<string, unknown>[]; totalRows: number } {
    this.ensureSeeded();
    const db = this.open();
    const tableSql = quoteSqliteQualifiedTable(params.schemaName, params.tableName);
    const safeCols = params.columns.map((c) => quoteSqliteIdentifier(c)).join(', ');
    const safeLimit = Math.min(Math.max(params.pageSize || 50, 1), 200);
    const offset = Math.max((params.page || 1) - 1, 0) * safeLimit;

    const bindValues: Array<string | number> = [];
    let whereSql = '';
    if (params.search && params.search.trim() !== '') {
      const term = `%${params.search.trim()}%`;
      const likes = params.columns.map((c) => `CAST(${quoteSqliteIdentifier(c)} AS TEXT) LIKE ?`);
      whereSql = `WHERE (${likes.join(' OR ')})`;
      for (let i = 0; i < params.columns.length; i += 1) {
        bindValues.push(term);
      }
    }

    const orderSql =
      params.sortColumn && validateIdentifier(params.sortColumn).valid
        ? `ORDER BY ${quoteSqliteIdentifier(params.sortColumn)} ${params.sortDir === 'DESC' ? 'DESC' : 'ASC'}`
        : '';

    const countRow = db
      .prepare(`SELECT COUNT(*) as total FROM ${tableSql} ${whereSql}`)
      .get(...bindValues) as { total: number };

    const rows = db
      .prepare(`SELECT ${safeCols} FROM ${tableSql} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
      .all(...bindValues, safeLimit, offset) as Record<string, unknown>[];

    return { rows, totalRows: countRow.total };
  }

  insertRow(schemaName: string, tableName: string, values: Record<string, unknown>): void {
    this.ensureSeeded();
    const db = this.open();
    const tableSql = quoteSqliteQualifiedTable(schemaName, tableName);
    const keys = Object.keys(values);
    if (keys.length === 0) throw new Error('Provide at least one field value to insert.');
    const colsSql = keys.map((k) => quoteSqliteIdentifier(k)).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    const params = keys.map((k) => {
      const v = values[k];
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v === undefined ? null : (v as string | number | null);
    });
    db.prepare(`INSERT INTO ${tableSql} (${colsSql}) VALUES (${placeholders})`).run(...params);
  }

  updateRowWithConcurrency(params: {
    schemaName: string;
    tableName: string;
    pkValues: Record<string, unknown>;
    updates: Record<string, unknown>;
    originalValues: Record<string, unknown>;
  }): { updatedCount: number } {
    this.ensureSeeded();
    const db = this.open();
    const tableSql = quoteSqliteQualifiedTable(params.schemaName, params.tableName);
    const updateKeys = Object.keys(params.updates);
    const pkKeys = Object.keys(params.pkValues);
    if (updateKeys.length === 0 || pkKeys.length === 0) {
      throw new Error('Primary key and updated fields are required.');
    }

    const setSql = updateKeys.map((k) => `${quoteSqliteIdentifier(k)} = ?`).join(', ');
    const whereParts: string[] = [];
    const bindParams: Array<string | number | null> = updateKeys.map((k) => {
      const v = params.updates[k];
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v === undefined ? null : (v as string | number | null);
    });

    for (const pk of pkKeys) {
      whereParts.push(`${quoteSqliteIdentifier(pk)} = ?`);
      bindParams.push(params.pkValues[pk] as string | number | null);
    }

    // Optimistic concurrency check on modified columns
    for (const k of updateKeys) {
      const orig = params.originalValues[k];
      if (orig === null || orig === undefined) {
        whereParts.push(`${quoteSqliteIdentifier(k)} IS NULL`);
      } else {
        whereParts.push(`${quoteSqliteIdentifier(k)} = ?`);
        bindParams.push(typeof orig === 'boolean' ? (orig ? 1 : 0) : (orig as string | number));
      }
    }

    const result = db
      .prepare(`UPDATE ${tableSql} SET ${setSql} WHERE ${whereParts.join(' AND ')}`)
      .run(...bindParams);

    return { updatedCount: Number(result.changes) };
  }

  deleteRowsByPk(
    schemaName: string,
    tableName: string,
    pkColumn: string,
    pkValues: Array<string | number>
  ): { deletedCount: number } {
    this.ensureSeeded();
    const db = this.open();
    const tableSql = quoteSqliteQualifiedTable(schemaName, tableName);
    const colSql = quoteSqliteIdentifier(pkColumn);
    if (pkValues.length === 0) return { deletedCount: 0 };

    const placeholders = pkValues.map(() => '?').join(', ');
    const result = db
      .prepare(`DELETE FROM ${tableSql} WHERE ${colSql} IN (${placeholders})`)
      .run(...pkValues);
    return { deletedCount: Number(result.changes) };
  }

  executeQuery(
    rawSql: string,
    orderedParams: unknown[] = [],
    allowMutations = false
  ): QueryExecutionResult {
    this.ensureSeeded();
    const db = this.open();
    const check = validateSqlStatement(rawSql, allowMutations);
    if (!check.valid) {
      throw new Error(check.error);
    }

    // Normalize T-SQL [dbo].[Table] references to sandbox "dbo.Table" for user convenience
    let executableSql = rawSql
      .trim()
      .replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]\.\[([A-Za-z_][A-Za-z0-9_]*)\]/g, '"$1.$2"')
      .replace(/\bTOP\s*\((\d+)\)/gi, '')
      .replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, '"$1"');

    // Convert dbo.Table (unquoted) in FROM/JOIN to "dbo.Table"
    executableSql = executableSql.replace(
      /\b(FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/gi,
      '$1 "$2.$3"'
    );

    const start = performance.now();
    if (check.statementType === 'SELECT' || check.statementType === 'EXPLAIN') {
      const stmt = db.prepare(executableSql);
      const allRows = stmt.all(...(orderedParams as Array<string | number | null>)) as Record<
        string,
        unknown
      >[];
      const truncated = allRows.length > 200;
      const rows = truncated ? allRows.slice(0, 200) : allRows;
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return {
        columns,
        rows,
        rowCount: rows.length,
        durationMs: Math.max(1, Math.round(performance.now() - start)),
        sqlExecuted: executableSql,
        truncated,
        statementType: check.statementType,
      };
    }

    const res = db.prepare(executableSql).run(...(orderedParams as Array<string | number | null>));
    return {
      columns: ['RowsAffected'],
      rows: [{ RowsAffected: Number(res.changes) }],
      rowCount: Number(res.changes),
      durationMs: Math.max(1, Math.round(performance.now() - start)),
      sqlExecuted: executableSql,
      truncated: false,
      statementType: 'MUTATION',
    };
  }

  applyOperations(operations: SchemaOperation[], snapshot: SchemaSnapshot): string {
    this.ensureSeeded();
    const db = this.open();
    const compiled = compileOperationsPlan(operations, snapshot);
    if (!compiled.preflight.passed) {
      const firstFail = compiled.preflight.checks.find((c) => c.status === 'fail');
      throw new Error(firstFail?.detail || 'Preflight validation failed.');
    }

    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const stmt of compiled.sqliteStatements) {
        db.exec(stmt);
      }
      // Handle ADD_FOREIGN_KEY in SQLite sandbox by rebuilding child table schema with FK constraint safely
      for (const op of operations) {
        if (op.kind === 'ADD_FOREIGN_KEY') {
          this.addForeignKeyInSqlite(op);
        }
      }
      db.exec('COMMIT;');
      return `Executed ${operations.length} operation(s) cleanly in transaction.`;
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  private addForeignKeyInSqlite(op: Extract<SchemaOperation, { kind: 'ADD_FOREIGN_KEY' }>) {
    const db = this.open();
    const fullSrc = `${op.sourceSchema}.${op.sourceTable}`;
    const fullTgt = `${op.targetSchema}.${op.targetTable}`;
    const createRow = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(fullSrc) as { sql: string } | undefined;
    if (!createRow?.sql) {
      throw new Error(`Source table ${fullSrc} not found.`);
    }

    // Verify existing rows satisfy FK integrity before adding constraint
    const orphanCount = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM "${fullSrc}" s
         WHERE s."${op.sourceColumn}" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM "${fullTgt}" t WHERE t."${op.targetColumn}" = s."${op.sourceColumn}"
         )`
      )
      .get() as { cnt: number };

    if (orphanCount.cnt > 0) {
      throw new Error(
        `Cannot add foreign key: ${orphanCount.cnt} row(s) in ${fullSrc} reference missing values in ${fullTgt}.${op.targetColumn}.`
      );
    }

    const tempName = `_vds_tmp_${op.sourceTable}_${Date.now()}`;
    const fkClause = `, FOREIGN KEY ("${op.sourceColumn}") REFERENCES "${fullTgt}"("${op.targetColumn}") ON DELETE ${op.onDelete} ON UPDATE ${op.onUpdate}`;
    const lastParen = createRow.sql.lastIndexOf(')');
    if (lastParen === -1) throw new Error('Unable to parse source table definition.');

    const newCreateSql =
      createRow.sql
        .slice(0, lastParen)
        .replace(`CREATE TABLE "${fullSrc}"`, `CREATE TABLE "${tempName}"`)
        .replace(`CREATE TABLE ${fullSrc}`, `CREATE TABLE "${tempName}"`) +
      fkClause +
      ')';

    db.exec('PRAGMA foreign_keys = OFF;');
    try {
      db.exec(newCreateSql);
      db.exec(`INSERT INTO "${tempName}" SELECT * FROM "${fullSrc}";`);
      db.exec(`DROP TABLE "${fullSrc}";`);
      db.exec(`ALTER TABLE "${tempName}" RENAME TO "${fullSrc}";`);
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }
}

export const sandboxDb = new SandboxDatabaseEngine();
