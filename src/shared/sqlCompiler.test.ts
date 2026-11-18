import test from 'node:test';
import assert from 'node:assert/strict';
import {
  areColumnTypesCompatibleForFk,
  compileOperationsPlan,
  compileVisualQuery,
  validateIdentifier,
  validateSqlStatement,
} from './sqlCompiler';

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

test('compileOperationsPlan marks DROP_COLUMN as destructive with confirm phrase', () => {
  const compiled = compileOperationsPlan([
    {
      kind: 'DROP_COLUMN',
      schemaName: 'dbo',
      tableName: 'Employees',
      columnName: 'Notes',
    },
  ]);

  assert.equal(compiled.riskLevel, 'destructive');
  assert.equal(compiled.requiresConfirmText, 'DROP Notes');
});

test('areColumnTypesCompatibleForFk matches auto_id with integer and rejects mismatches', () => {
  assert.equal(areColumnTypesCompatibleForFk('auto_id', 'integer'), true);
  assert.equal(areColumnTypesCompatibleForFk('text', 'integer'), false);
});

test('compileVisualQuery produces parameterized SQL with bounded row limit', () => {
  const result = compileVisualQuery(
    {
      schemaName: 'dbo',
      tableName: 'Employees',
      columns: ['EmployeeID', 'FullName'],
      filters: [
        { id: 'f1', column: 'Status', operator: 'eq', value: "Active'; DROP TABLE Employees--" },
      ],
      orderBy: { column: 'FullName', direction: 'ASC' },
      limit: 5000, // should cap to 500
    },
    'tsql'
  );

  assert.match(result.sql, /SELECT TOP \(500\) \[EmployeeID\], \[FullName\]/);
  assert.match(result.sql, /WHERE \[Status\] = @p0/);
  assert.equal(result.params.p0, "Active'; DROP TABLE Employees--");
});

test('validateSqlStatement enforces read-only and blocks server-level commands', () => {
  assert.equal(validateSqlStatement('SELECT * FROM dbo.Employees', false).valid, true);
  assert.equal(validateSqlStatement('DELETE FROM dbo.Employees', false).valid, false);
  assert.equal(validateSqlStatement('DELETE FROM dbo.Employees WHERE EmployeeID = 1', true).valid, true);
  assert.equal(validateSqlStatement('EXEC xp_cmdshell "dir"', true).valid, false);
  assert.equal(validateSqlStatement('SELECT 1; DROP TABLE dbo.Employees', true).valid, false);
});
