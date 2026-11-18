import test from 'node:test';
import assert from 'node:assert/strict';
import {
  areColumnTypesCompatibleForFk,
  compileOperationsPlan,
  compileVisualQuery,
  diffSchemaSnapshots,
  explainSqlError,
  formatSql,
  generateSchemaMarkdownDocs,
  validateIdentifier,
  validateSqlStatement,
} from './sqlCompiler';
import { SchemaSnapshot } from './types';

test('validateIdentifier rejects SQL injection attempts and reserved words', () => {
  assert.equal(validateIdentifier('Employees').valid, true);
  assert.equal(validateIdentifier('emp_id_2').valid, true);
  assert.equal(validateIdentifier('Employees; DROP TABLE Users--').valid, false);
  assert.equal(validateIdentifier('123bad').valid, false);
  assert.equal(validateIdentifier('SELECT').valid, false);
  assert.equal(validateIdentifier('[dbo]').valid, false);
});

test('compileOperationsPlan compiles safe CREATE TABLE with friendly types', () => {
  const compiled = compileOperationsPlan([
    {
      kind: 'CREATE_TABLE',
      schemaName: 'dbo',
      tableName: 'Projects',
      fields: [
        {
          id: '1',
          name: 'ProjectID',
          friendlyType: 'auto_id',
          nullable: false,
          isPrimaryKey: true,
          isIdentity: true,
          isUnique: true,
        },
        {
          id: '2',
          name: 'Title',
          friendlyType: 'text',
          length: 150,
          nullable: false,
          isPrimaryKey: false,
          isIdentity: false,
          isUnique: false,
        },
        {
          id: '3',
          name: 'Budget',
          friendlyType: 'money',
          nullable: true,
          isPrimaryKey: false,
          isIdentity: false,
          isUnique: false,
        },
      ],
    },
  ]);

  assert.equal(compiled.riskLevel, 'low');
  assert.equal(compiled.preflight.passed, true);
  assert.match(compiled.tsql, /CREATE TABLE \[dbo\]\.\[Projects\]/);
  assert.match(compiled.tsql, /\[ProjectID\] INT IDENTITY\(1,1\) NOT NULL/);
  assert.match(compiled.tsql, /\[Title\] NVARCHAR\(150\) NOT NULL/);
  assert.match(compiled.tsql, /\[Budget\] DECIMAL\(19,4\) NULL/);
  assert.match(compiled.sqliteStatements[0], /CREATE TABLE "dbo\.Projects"/);
});

test('compileOperationsPlan compiles ALTER_COLUMN, keys, constraints, indexes, rename, and CREATE DATABASE T-SQL', () => {
  const alterRes = compileOperationsPlan([
    {
      kind: 'ALTER_COLUMN',
      schemaName: 'dbo',
      tableName: 'Employees',
      columnName: 'RoleTitle',
      friendlyType: 'text',
      length: 200,
      nullable: false,
    },
  ]);
  assert.equal(alterRes.riskLevel, 'high');
  assert.match(alterRes.tsql, /ALTER TABLE \[dbo\]\.\[Employees\] ALTER COLUMN \[RoleTitle\] NVARCHAR\(200\) NOT NULL;/);

  const keyIdxRes = compileOperationsPlan([
    {
      kind: 'ADD_PRIMARY_KEY',
      schemaName: 'dbo',
      tableName: 'AuditLog',
      constraintName: 'PK_AuditLog',
      columns: ['AuditID'],
    },
    {
      kind: 'ADD_UNIQUE_CONSTRAINT',
      schemaName: 'dbo',
      tableName: 'Employees',
      constraintName: 'UQ_Employees_Email',
      columns: ['Email'],
    },
    {
      kind: 'CREATE_INDEX',
      schemaName: 'dbo',
      tableName: 'Employees',
      indexName: 'IX_Employees_Dept',
      columns: ['DepartmentID', 'FullName'],
      isUnique: false,
    },
    {
      kind: 'DROP_INDEX',
      schemaName: 'dbo',
      tableName: 'Employees',
      indexName: 'IX_Employees_Old',
    },
  ]);
  assert.match(keyIdxRes.tsql, /ADD CONSTRAINT \[PK_AuditLog\] PRIMARY KEY CLUSTERED \(\[AuditID\]\)/);
  assert.match(keyIdxRes.tsql, /ADD CONSTRAINT \[UQ_Employees_Email\] UNIQUE \(\[Email\]\)/);
  assert.match(keyIdxRes.tsql, /CREATE NONCLUSTERED INDEX \[IX_Employees_Dept\]/);
  assert.match(keyIdxRes.tsql, /DROP INDEX \[IX_Employees_Old\] ON \[dbo\]\.\[Employees\];/);

  const renameCol = compileOperationsPlan([
    {
      kind: 'RENAME_OBJECT',
      schemaName: 'dbo',
      tableName: 'Employees',
      columnName: 'RoleTitle',
      newName: 'JobTitle',
    },
  ]);
  assert.match(renameCol.tsql, /EXEC sp_rename N'dbo\.Employees\.RoleTitle', N'JobTitle', N'COLUMN';/);

  const createDb = compileOperationsPlan([
    {
      kind: 'CREATE_DATABASE',
      databaseName: 'AnalyticsWarehouse',
      collation: 'SQL_Latin1_General_CP1_CI_AS',
    },
  ]);
  assert.match(createDb.tsql, /CREATE DATABASE \[AnalyticsWarehouse\] COLLATE SQL_Latin1_General_CP1_CI_AS;/);
});

test('compileOperationsPlan marks DROP_COLUMN, DROP_TABLE, and DROP_CONSTRAINT with confirm phrase', () => {
  const colDrop = compileOperationsPlan([
    { kind: 'DROP_COLUMN', schemaName: 'dbo', tableName: 'Employees', columnName: 'Notes' },
  ]);
  assert.equal(colDrop.riskLevel, 'destructive');
  assert.equal(colDrop.requiresConfirmText, 'DROP Notes');

  const tblDrop = compileOperationsPlan([
    { kind: 'DROP_TABLE', schemaName: 'dbo', tableName: 'TempImport' },
  ]);
  assert.equal(tblDrop.riskLevel, 'destructive');
  assert.equal(tblDrop.requiresConfirmText, 'DROP TempImport');

  const conDrop = compileOperationsPlan([
    { kind: 'DROP_CONSTRAINT', schemaName: 'dbo', tableName: 'Employees', constraintName: 'UQ_Employees_Email' },
  ]);
  assert.equal(conDrop.riskLevel, 'high');
  assert.equal(conDrop.requiresConfirmText, 'DROP UQ_Employees_Email');
});

test('areColumnTypesCompatibleForFk matches auto_id with integer and rejects mismatches', () => {
  assert.equal(areColumnTypesCompatibleForFk('auto_id', 'integer'), true);
  assert.equal(areColumnTypesCompatibleForFk('text', 'integer'), false);
});

test('compileVisualQuery produces parameterized T-SQL with joins, aggregates, GROUP BY, and bounded limit', () => {
  const result = compileVisualQuery(
    {
      schemaName: 'dbo',
      tableName: 'Employees',
      columns: ['DepartmentID'],
      joins: [
        {
          id: 'j1',
          joinType: 'INNER',
          targetSchema: 'dbo',
          targetTable: 'Departments',
          sourceColumn: 'DepartmentID',
          targetColumn: 'DepartmentID',
        },
      ],
      aggregates: [{ func: 'COUNT', column: '*', alias: 'Headcount' }],
      filters: [
        { id: 'f1', column: 'Status', operator: 'eq', value: "Active'; DROP TABLE Employees--" },
      ],
      groupBy: ['DepartmentID'],
      orderBy: { column: 'DepartmentID', direction: 'ASC' },
      limit: 5000,
    },
    'tsql'
  );

  assert.match(result.sql, /SELECT TOP \(1000\) t0\.\[DepartmentID\], COUNT\(\*\) AS \[Headcount\]/);
  assert.match(result.sql, /INNER JOIN \[dbo\]\.\[Departments\] AS j1 ON t0\.\[DepartmentID\] = j1\.\[DepartmentID\]/);
  assert.match(result.sql, /WHERE t0\.\[Status\] = @p0/);
  assert.match(result.sql, /GROUP BY t0\.\[DepartmentID\]/);
  assert.equal(result.params.p0, "Active'; DROP TABLE Employees--");
});

test('validateSqlStatement enforces read-only and blocks server-level commands', () => {
  assert.equal(validateSqlStatement('SELECT * FROM dbo.Employees', false).valid, true);
  assert.equal(validateSqlStatement('DELETE FROM dbo.Employees', false).valid, false);
  assert.equal(validateSqlStatement('DELETE FROM dbo.Employees WHERE EmployeeID = 1', true).valid, true);
  assert.equal(validateSqlStatement('EXEC xp_cmdshell "dir"', true).valid, false);
  assert.equal(validateSqlStatement('SELECT 1; DROP TABLE dbo.Employees', true).valid, false);
});

test('formatSql, explainSqlError, diffSchemaSnapshots, and generateSchemaMarkdownDocs behave deterministically', () => {
  const formatted = formatSql("select top 10 a, b from dbo.Employees where status = 'Active' and id > 5 order by b desc");
  assert.match(formatted, /^SELECT TOP 10/);
  assert.match(formatted, /\nFROM dbo\.Employees/);
  assert.match(formatted, /\nWHERE status = 'Active'\n  AND id > 5/);

  const loginErr = explainSqlError('Login failed for user sa. Error 18456');
  assert.equal(loginErr.code, 18456);
  const tlsErr = explainSqlError('self signed certificate in certificate chain');
  assert.match(tlsErr.title, /TLS|Certificate/i);

  const base: SchemaSnapshot = {
    connectionId: 'c1',
    databaseName: 'OpsDb',
    engineVersion: 'SQL Server 2022',
    capturedAt: '2026-01-01T00:00:00Z',
    fingerprint: 'fp_1',
    schemas: ['dbo'],
    tables: [
      {
        schemaName: 'dbo',
        tableName: 'Users',
        fullName: 'dbo.Users',
        objectType: 'TABLE',
        rowCountEstimate: 10,
        hasStablePrimaryKey: true,
        primaryKeyColumns: ['UserID'],
        hasRowVersion: false,
        columns: [
          {
            name: 'UserID',
            friendlyType: 'auto_id',
            sqlType: 'INT IDENTITY(1,1)',
            nullable: false,
            isPrimaryKey: true,
            isIdentity: true,
            isUnique: true,
            defaultValue: null,
            ordinalPosition: 1,
          },
        ],
        foreignKeys: [],
        indexes: [],
      },
    ],
  };

  const live: SchemaSnapshot = {
    ...base,
    fingerprint: 'fp_2',
    tables: [
      ...base.tables,
      {
        ...base.tables[0],
        tableName: 'Audit',
        fullName: 'dbo.Audit',
      },
    ],
  };

  const drift = diffSchemaSnapshots('fp_1', base, live);
  assert.equal(drift.drifted, true);
  assert.deepEqual(drift.addedTables, ['dbo.Audit']);

  const docs = generateSchemaMarkdownDocs(live);
  assert.match(docs, /# Database Data Dictionary: OpsDb/);
  assert.match(docs, /## dbo\.Users \(TABLE\)/);
});
