import {
  FieldDraft,
  FieldTypeMapping,
  FriendlyFieldType,
  PreflightReport,
  RiskLevel,
  SchemaDriftReport,
  SchemaOperation,
  SchemaSnapshot,
  SqlErrorExplanation,
  VisualQuerySpec,
} from './types';

export const FRIENDLY_FIELD_TYPES: FieldTypeMapping[] = [
  {
    friendlyType: 'auto_id',
    label: 'Automatic ID',
    description: 'Auto-incrementing whole number ideal for primary keys.',
    tsqlType: 'INT IDENTITY(1,1)',
  },
  {
    friendlyType: 'text',
    label: 'Text',
    description: 'Short to medium Unicode text such as names or codes.',
    tsqlType: 'NVARCHAR',
    supportsLength: true,
    defaultLength: 120,
  },
  {
    friendlyType: 'long_text',
    label: 'Long Text',
    description: 'Notes, descriptions, or multi-paragraph text.',
    tsqlType: 'NVARCHAR(MAX)',
  },
  {
    friendlyType: 'integer',
    label: 'Whole Number',
    description: 'Counts, quantities, or integer measurements.',
    tsqlType: 'INT',
  },
  {
    friendlyType: 'decimal',
    label: 'Decimal Number',
    description: 'Exact numeric values with fractional digits.',
    tsqlType: 'DECIMAL',
    supportsPrecision: true,
    defaultPrecision: 18,
    defaultScale: 2,
  },
  {
    friendlyType: 'money',
    label: 'Currency / Money',
    description: 'Financial amounts stored with exact precision.',
    tsqlType: 'DECIMAL(19,4)',
  },
  {
    friendlyType: 'date',
    label: 'Date',
    description: 'Calendar date without time of day.',
    tsqlType: 'DATE',
  },
  {
    friendlyType: 'datetime',
    label: 'Date and Time',
    description: 'Timestamp including date and time.',
    tsqlType: 'DATETIME2',
  },
  {
    friendlyType: 'boolean',
    label: 'Yes / No',
    description: 'True or false flag.',
    tsqlType: 'BIT',
  },
  {
    friendlyType: 'uuid',
    label: 'Unique Identifier',
    description: 'Globally unique UUID/GUID value.',
    tsqlType: 'UNIQUEIDENTIFIER',
  },
];

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const RESERVED_SQL_WORDS = new Set([
  'SELECT',
  'DROP',
  'TRUNCATE',
  'EXEC',
  'EXECUTE',
  'UNION',
  'INSERT',
  'UPDATE',
  'DELETE',
  'ALTER',
  'CREATE',
  'SYS',
]);

export function validateIdentifier(
  raw: string,
  label = 'Identifier'
): { valid: true; value: string } | { valid: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, error: `${label} cannot be empty.` };
  }
  if (!IDENTIFIER_RE.test(trimmed)) {
    return {
      valid: false,
      error: `${label} "${trimmed}" must start with a letter or underscore and contain only letters, numbers, and underscores (max 128 chars).`,
    };
  }
  if (RESERVED_SQL_WORDS.has(trimmed.toUpperCase())) {
    return {
      valid: false,
      error: `${label} "${trimmed}" is a reserved SQL keyword and cannot be used directly.`,
    };
  }
  return { valid: true, value: trimmed };
}

export function quoteTsqlIdentifier(identifier: string): string {
  const check = validateIdentifier(identifier);
  if (!check.valid) {
    throw new Error(check.error);
  }
  return `[${check.value}]`;
}

export function quoteSqliteIdentifier(identifier: string): string {
  const check = validateIdentifier(identifier);
  if (!check.valid) {
    throw new Error(check.error);
  }
  return `"${check.value}"`;
}

export function quoteSqliteQualifiedTable(schemaName: string, tableName: string): string {
  const s = validateIdentifier(schemaName, 'Schema');
  const t = validateIdentifier(tableName, 'Table');
  if (!s.valid) throw new Error(s.error);
  if (!t.valid) throw new Error(t.error);
  return `"${s.value}.${t.value}"`;
}

export function mapFriendlyToSqlServerType(field: {
  friendlyType: FriendlyFieldType;
  length?: number;
  precision?: number;
  scale?: number;
}): string {
  switch (field.friendlyType) {
    case 'auto_id':
      return 'INT IDENTITY(1,1)';
    case 'text': {
      const len = Math.min(Math.max(field.length ?? 120, 1), 4000);
      return `NVARCHAR(${len})`;
    }
    case 'long_text':
      return 'NVARCHAR(MAX)';
    case 'integer':
      return 'INT';
    case 'decimal': {
      const p = Math.min(Math.max(field.precision ?? 18, 1), 38);
      const s = Math.min(Math.max(field.scale ?? 2, 0), p);
      return `DECIMAL(${p},${s})`;
    }
    case 'money':
      return 'DECIMAL(19,4)';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'DATETIME2';
    case 'boolean':
      return 'BIT';
    case 'uuid':
      return 'UNIQUEIDENTIFIER';
  }
}

export function mapSqlTypeToFriendly(sqlType: string, isIdentity: boolean): FriendlyFieldType {
  if (isIdentity) return 'auto_id';
  const upper = sqlType.toUpperCase();
  if (upper.includes('MAX') || upper === 'TEXT' || upper === 'NTEXT') return 'long_text';
  if (upper.includes('CHAR')) return 'text';
  if (upper.includes('MONEY')) return 'money';
  if (upper.includes('DECIMAL') || upper.includes('NUMERIC') || upper.includes('FLOAT') || upper.includes('REAL')) {
    return 'decimal';
  }
  if (upper === 'DATE') return 'date';
  if (upper.includes('DATETIME') || upper.includes('TIMESTAMP')) return 'datetime';
  if (upper === 'BIT' || upper === 'BOOLEAN') return 'boolean';
  if (upper.includes('UNIQUEIDENTIFIER') || upper.includes('UUID')) return 'uuid';
  if (upper.includes('INT')) return 'integer';
  return 'text';
}

export function areColumnTypesCompatibleForFk(
  sourceType: FriendlyFieldType,
  targetType: FriendlyFieldType
): boolean {
  const normalize = (t: FriendlyFieldType) => (t === 'auto_id' ? 'integer' : t);
  return normalize(sourceType) === normalize(targetType);
}

function sanitizeLiteralDefault(val: string, type: FriendlyFieldType): string {
  const trimmed = val.trim();
  if (type === 'boolean') {
    if (trimmed === '1' || trimmed.toLowerCase() === 'true') return '1';
    if (trimmed === '0' || trimmed.toLowerCase() === 'false') return '0';
    throw new Error(`Invalid boolean default "${val}". Use 0, 1, true, or false.`);
  }
  if (type === 'integer' || type === 'decimal' || type === 'money') {
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
      throw new Error(`Invalid numeric default "${val}".`);
    }
    return trimmed;
  }
  if ((type === 'datetime' || type === 'date') && /^(GETDATE\(\)|CURRENT_TIMESTAMP|SYSUTCDATETIME\(\))$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  if (trimmed.length > 200) {
    throw new Error('Default value exceeds 200 characters.');
  }
  return `N'${trimmed.replace(/'/g, "''")}'`;
}

export interface CompiledOperationPlan {
  tsql: string;
  sqliteStatements: string[];
  plainExplanation: string;
  riskLevel: RiskLevel;
  requiresConfirmText: string | null;
  preflight: PreflightReport;
}

export function compileOperationsPlan(
  operations: SchemaOperation[],
  snapshot?: SchemaSnapshot | null
): CompiledOperationPlan {
  if (operations.length === 0) {
    throw new Error('At least one schema operation is required.');
  }

  const tsqlChunks: string[] = [];
  const sqliteStatements: string[] = [];
  const explanations: string[] = [];
  const warnings: string[] = [];
  const checks: PreflightReport['checks'] = [];
  let riskLevel: RiskLevel = 'low';
  let requiresConfirmText: string | null = null;
  let passed = true;

  const elevateRisk = (next: RiskLevel) => {
    const order: Record<RiskLevel, number> = {
      low: 0,
      medium: 1,
      high: 2,
      destructive: 3,
    };
    if (order[next] > order[riskLevel]) {
      riskLevel = next;
    }
  };

  for (const op of operations) {
    if (op.kind === 'CREATE_TABLE') {
      const schemaCheck = validateIdentifier(op.schemaName, 'Schema name');
      const tableCheck = validateIdentifier(op.tableName, 'Table name');
      if (!schemaCheck.valid) throw new Error(schemaCheck.error);
      if (!tableCheck.valid) throw new Error(tableCheck.error);
      if (!op.fields || op.fields.length === 0) {
        throw new Error('A table must contain at least one field.');
      }

      const fullTable = `${schemaCheck.value}.${tableCheck.value}`;
      const existing = snapshot?.tables.find(
        (t) => t.fullName.toLowerCase() === fullTable.toLowerCase()
      );
      if (existing) {
        passed = false;
        checks.push({
          name: 'Duplicate table check',
          status: 'fail',
          detail: `Table ${fullTable} already exists in the current database snapshot.`,
        });
      } else {
        checks.push({
          name: 'Table name availability',
          status: 'pass',
          detail: `${fullTable} does not conflict with existing tables.`,
        });
      }

      const seenCols = new Set<string>();
      const pkCols: string[] = [];
      let identityCount = 0;

      const tsqlColDefs: string[] = [];
      const sqliteColDefs: string[] = [];

      for (const field of op.fields) {
        const colCheck = validateIdentifier(field.name, 'Field name');
        if (!colCheck.valid) throw new Error(colCheck.error);
        const lower = colCheck.value.toLowerCase();
        if (seenCols.has(lower)) {
          throw new Error(`Duplicate field name "${colCheck.value}" in table ${fullTable}.`);
        }
        seenCols.add(lower);

        if (field.friendlyType === 'auto_id' || field.isIdentity) {
          identityCount += 1;
        }
        if (field.isPrimaryKey) {
          pkCols.push(colCheck.value);
        }

        const tsqlType = mapFriendlyToSqlServerType(field);
        const nullSql = field.nullable && !field.isPrimaryKey ? 'NULL' : 'NOT NULL';
        const uniqueSql = field.isUnique && !field.isPrimaryKey ? ' UNIQUE' : '';
        const defaultSql =
          field.defaultValue && field.defaultValue.trim() !== ''
            ? ` DEFAULT (${sanitizeLiteralDefault(field.defaultValue, field.friendlyType)})`
            : '';

        tsqlColDefs.push(
          `  ${quoteTsqlIdentifier(colCheck.value)} ${tsqlType} ${nullSql}${uniqueSql}${defaultSql}`
        );

        if (field.friendlyType === 'auto_id' || (field.isIdentity && field.isPrimaryKey)) {
          sqliteColDefs.push(`  ${quoteSqliteIdentifier(colCheck.value)} INTEGER PRIMARY KEY AUTOINCREMENT`);
        } else {
          const sqliteType =
            field.friendlyType === 'integer' || field.friendlyType === 'boolean'
              ? 'INTEGER'
              : field.friendlyType === 'decimal' || field.friendlyType === 'money'
              ? 'REAL'
              : 'TEXT';
          const sqliteNull = field.nullable && !field.isPrimaryKey ? '' : ' NOT NULL';
          const sqliteUniq = field.isUnique && !field.isPrimaryKey ? ' UNIQUE' : '';
          const sqliteDef =
            field.defaultValue && field.defaultValue.trim() !== ''
              ? ` DEFAULT ${
                  /^(GETDATE\(\)|CURRENT_TIMESTAMP|SYSUTCDATETIME\(\))$/i.test(field.defaultValue.trim())
                    ? 'CURRENT_TIMESTAMP'
                    : sanitizeLiteralDefault(field.defaultValue, field.friendlyType).replace(/^N'/, "'")
                }`
              : '';
          sqliteColDefs.push(
            `  ${quoteSqliteIdentifier(colCheck.value)} ${sqliteType}${sqliteNull}${sqliteUniq}${sqliteDef}`
          );
        }
      }

      if (identityCount > 1) {
        throw new Error('SQL Server allows at most one IDENTITY (Automatic ID) column per table.');
      }

      if (pkCols.length === 0) {
        warnings.push(
          `Table ${fullTable} has no Primary Key. Without a stable Primary Key, inline row editing in Records will stay read-only.`
        );
        checks.push({
          name: 'Primary key safety',
          status: 'warn',
          detail: 'No primary key selected; row editing will be read-only until a primary key is defined.',
        });
      } else {
        checks.push({
          name: 'Primary key safety',
          status: 'pass',
          detail: `Primary key (${pkCols.join(', ')}) guarantees stable single-row identity.`,
        });
        tsqlColDefs.push(
          `  CONSTRAINT ${quoteTsqlIdentifier(`PK_${tableCheck.value}`)} PRIMARY KEY CLUSTERED (${pkCols
            .map(quoteTsqlIdentifier)
            .join(', ')})`
        );
        const hasAutoIdPk = op.fields.some(
          (f) => f.isPrimaryKey && (f.friendlyType === 'auto_id' || f.isIdentity)
        );
        if (!hasAutoIdPk) {
          sqliteColDefs.push(`  PRIMARY KEY (${pkCols.map(quoteSqliteIdentifier).join(', ')})`);
        }
      }

      tsqlChunks.push(
        `CREATE TABLE ${quoteTsqlIdentifier(schemaCheck.value)}.${quoteTsqlIdentifier(
          tableCheck.value
        )} (\n${tsqlColDefs.join(',\n')}\n);`
      );
      sqliteStatements.push(
        `CREATE TABLE ${quoteSqliteQualifiedTable(schemaCheck.value, tableCheck.value)} (\n${sqliteColDefs.join(
          ',\n'
        )}\n);`
      );
      explanations.push(
        `Creates new table ${fullTable} with ${op.fields.length} field${op.fields.length === 1 ? '' : 's'}.`
      );
    } else if (op.kind === 'ADD_COLUMN') {
      const schemaCheck = validateIdentifier(op.schemaName, 'Schema name');
      const tableCheck = validateIdentifier(op.tableName, 'Table name');
      const colCheck = validateIdentifier(op.field.name, 'Field name');
      if (!schemaCheck.valid) throw new Error(schemaCheck.error);
      if (!tableCheck.valid) throw new Error(tableCheck.error);
      if (!colCheck.valid) throw new Error(colCheck.error);

      const fullTable = `${schemaCheck.value}.${tableCheck.value}`;
      const existingTable = snapshot?.tables.find(
        (t) => t.fullName.toLowerCase() === fullTable.toLowerCase()
      );
      if (existingTable) {
        const duplicate = existingTable.columns.some(
          (c) => c.name.toLowerCase() === colCheck.value.toLowerCase()
        );
        if (duplicate) {
          passed = false;
          checks.push({
            name: 'Column conflict check',
            status: 'fail',
            detail: `Column "${colCheck.value}" already exists on ${fullTable}.`,
          });
        }
        if (
          !op.field.nullable &&
          (!op.field.defaultValue || op.field.defaultValue.trim() === '') &&
          existingTable.rowCountEstimate > 0
        ) {
          passed = false;
          checks.push({
            name: 'Non-nullable column safety',
            status: 'fail',
            detail: `Adding required column "${colCheck.value}" to populated table ${fullTable} requires a default value.`,
          });
        }
      }

      const tsqlType = mapFriendlyToSqlServerType(op.field);
      const nullSql = op.field.nullable ? 'NULL' : 'NOT NULL';
      const defSql =
        op.field.defaultValue && op.field.defaultValue.trim() !== ''
          ? ` CONSTRAINT ${quoteTsqlIdentifier(`DF_${tableCheck.value}_${colCheck.value}`)} DEFAULT (${sanitizeLiteralDefault(
              op.field.defaultValue,
              op.field.friendlyType
            )})`
          : '';
      tsqlChunks.push(
        `ALTER TABLE ${quoteTsqlIdentifier(schemaCheck.value)}.${quoteTsqlIdentifier(
          tableCheck.value
        )} ADD ${quoteTsqlIdentifier(colCheck.value)} ${tsqlType} ${nullSql}${defSql};`
      );

      const sqliteType =
        op.field.friendlyType === 'integer' || op.field.friendlyType === 'boolean'
          ? 'INTEGER'
          : op.field.friendlyType === 'decimal' || op.field.friendlyType === 'money'
          ? 'REAL'
          : 'TEXT';
      const sqliteDef =
        op.field.defaultValue && op.field.defaultValue.trim() !== ''
          ? ` DEFAULT ${sanitizeLiteralDefault(op.field.defaultValue, op.field.friendlyType).replace(/^N'/, "'")}`
          : op.field.nullable
          ? ''
          : ` DEFAULT ''`;
      sqliteStatements.push(
        `ALTER TABLE ${quoteSqliteQualifiedTable(schemaCheck.value, tableCheck.value)} ADD COLUMN ${quoteSqliteIdentifier(
          colCheck.value
        )} ${sqliteType}${sqliteDef};`
      );
      elevateRisk('medium');
      explanations.push(`Adds field "${colCheck.value}" to ${fullTable}.`);
    } else if (op.kind === 'ALTER_COLUMN') {
      const schemaCheck = validateIdentifier(op.schemaName, 'Schema name');
      const tableCheck = validateIdentifier(op.tableName, 'Table name');
      const colCheck = validateIdentifier(op.columnName, 'Column name');
      if (!schemaCheck.valid) throw new Error(schemaCheck.error);
      if (!tableCheck.valid) throw new Error(tableCheck.error);
      if (!colCheck.valid) throw new Error(colCheck.error);
      if (op.friendlyType === 'auto_id') {
        throw new Error('Cannot alter an existing column into an IDENTITY column via ALTER COLUMN.');
      }

      const fullTable = `${schemaCheck.value}.${tableCheck.value}`;
      const existingTable = snapshot?.tables.find(
        (t) => t.fullName.toLowerCase() === fullTable.toLowerCase()
      );
      const existingCol = existingTable?.columns.find(
        (c) => c.name.toLowerCase() === colCheck.value.toLowerCase()
      );
      if (existingCol?.isPrimaryKey && op.nullable) {
        passed = false;
        checks.push({
          name: 'Primary key nullability check',
          status: 'fail',
          detail: `Column "${colCheck.value}" belongs to the Primary Key and cannot be made NULL.`,
        });
      }
      if (existingCol && !op.nullable && existingCol.nullable && (existingTable?.rowCountEstimate ?? 0) > 0) {
        warnings.push(
          `Tightening "${colCheck.value}" to NOT NULL on populated table ${fullTable} will fail if existing rows contain NULL values.`
        );
      }

      const tsqlType = mapFriendlyToSqlServerType(op);
      const nullSql = op.nullable ? 'NULL' : 'NOT NULL';
      tsqlChunks.push(
        `ALTER TABLE ${quoteTsqlIdentifier(schemaCheck.value)}.${quoteTsqlIdentifier(
          tableCheck.value
        )} ALTER COLUMN ${quoteTsqlIdentifier(colCheck.value)} ${tsqlType} ${nullSql};`
      );
      elevateRisk('high');
      explanations.push(`Modifies column "${colCheck.value}" on ${fullTable} to ${tsqlType} ${nullSql}.`);
    } else if (op.kind === 'DROP_COLUMN') {
      const schemaCheck = validateIdentifier(op.schemaName, 'Schema name');
      const tableCheck = validateIdentifier(op.tableName, 'Table name');
      const colCheck = validateIdentifier(op.columnName, 'Column name');
      if (!schemaCheck.valid) throw new Error(schemaCheck.error);
      if (!tableCheck.valid) throw new Error(tableCheck.error);
      if (!colCheck.valid) throw new Error(colCheck.error);

      const fullTable = `${schemaCheck.value}.${tableCheck.value}`;
      const existingTable = snapshot?.tables.find(
        (t) => t.fullName.toLowerCase() === fullTable.toLowerCase()
      );
      if (existingTable) {
        if (existingTable.primaryKeyColumns.includes(colCheck.value)) {
          passed = false;
          checks.push({
            name: 'Primary key dependency check',
            status: 'fail',
            detail: `Cannot drop "${colCheck.value}" because it belongs to the primary key of ${fullTable}.`,
          });
        }
        const fkRef = snapshot?.tables.some((t) =>
          t.foreignKeys.some(
            (fk) =>
              (fk.sourceTable === tableCheck.value && fk.sourceColumn === colCheck.value) ||
              (fk.targetTable === tableCheck.value && fk.targetColumn === colCheck.value)
          )
        );
        if (fkRef) {
          passed = false;
          checks.push({
            name: 'Foreign key dependency check',
            status: 'fail',
            detail: `Column "${colCheck.value}" is referenced by a foreign key constraint.`,
          });
        }
        if (existingTable.rowCountEstimate > 0) {
          warnings.push(
            `DATA-LOSS WARNING: ${fullTable} contains ~${existingTable.rowCountEstimate} rows. Dropping "${colCheck.value}" permanently destroys all values in that column.`
          );
        }
      }

      elevateRisk('destructive');
      requiresConfirmText = `DROP ${colCheck.value}`;
      tsqlChunks.push(
        `ALTER TABLE ${quoteTsqlIdentifier(schemaCheck.value)}.${quoteTsqlIdentifier(
          tableCheck.value
        )} DROP COLUMN ${quoteTsqlIdentifier(colCheck.value)};`
      );
      sqliteStatements.push(
        `ALTER TABLE ${quoteSqliteQualifiedTable(schemaCheck.value, tableCheck.value)} DROP COLUMN ${quoteSqliteIdentifier(
          colCheck.value
        )};`
      );
      explanations.push(`Permanently deletes column "${colCheck.value}" from ${fullTable}.`);
    } else if (op.kind === 'DROP_TABLE') {
      const schemaCheck = validateIdentifier(op.schemaName, 'Schema name');
      const tableCheck = validateIdentifier(op.tableName, 'Table name');
      if (!schemaCheck.valid) throw new Error(schemaCheck.error);
      if (!tableCheck.valid) throw new Error(tableCheck.error);

      const fullTable = `${schemaCheck.value}.${tableCheck.value}`;
      elevateRisk('destructive');
      requiresConfirmText = `DROP ${tableCheck.value}`;
      warnings.push(
        `DESTRUCTIVE ACTION: Dropping ${fullTable} permanently removes the table and all its records. Ensure a verified SQL Server backup exists before applying.`
      );
      checks.push({
        name: 'Destructive DDL safeguard',
        status: 'warn',
        detail: `Requires explicit confirmation phrase "${requiresConfirmText}".`,
      });
      tsqlChunks.push(
        `DROP TABLE ${quoteTsqlIdentifier(schemaCheck.value)}.${quoteTsqlIdentifier(tableCheck.value)};`
      );
      sqliteStatements.push(
        `DROP TABLE ${quoteSqliteQualifiedTable(schemaCheck.value, tableCheck.value)};`
      );
      explanations.push(`Permanently deletes table ${fullTable} and all stored records.`);
    } else if (op.kind === 'ADD_FOREIGN_KEY') {
      const cName = validateIdentifier(op.constraintName, 'Constraint name');
      const sSchema = validateIdentifier(op.sourceSchema, 'Source schema');
      const sTable = validateIdentifier(op.sourceTable, 'Source table');
      const sCol = validateIdentifier(op.sourceColumn, 'Source column');
      const tSchema = validateIdentifier(op.targetSchema, 'Target schema');
      const tTable = validateIdentifier(op.targetTable, 'Target table');
      const tCol = validateIdentifier(op.targetColumn, 'Target column');
      if (!cName.valid) throw new Error(cName.error);
      if (!sSchema.valid) throw new Error(sSchema.error);
      if (!sTable.valid) throw new Error(sTable.error);
      if (!sCol.valid) throw new Error(sCol.error);
      if (!tSchema.valid) throw new Error(tSchema.error);
      if (!tTable.valid) throw new Error(tTable.error);
      if (!tCol.valid) throw new Error(tCol.error);

      if (snapshot) {
        const srcTbl = snapshot.tables.find(
          (t) => t.fullName.toLowerCase() === `${sSchema.value}.${sTable.value}`.toLowerCase()
        );
        const tgtTbl = snapshot.tables.find(
          (t) => t.fullName.toLowerCase() === `${tSchema.value}.${tTable.value}`.toLowerCase()
        );
        const srcField = srcTbl?.columns.find((c) => c.name.toLowerCase() === sCol.value.toLowerCase());
        const tgtField = tgtTbl?.columns.find((c) => c.name.toLowerCase() === tCol.value.toLowerCase());
        if (srcField && tgtField) {
          if (!areColumnTypesCompatibleForFk(srcField.friendlyType, tgtField.friendlyType)) {
            passed = false;
            checks.push({
              name: 'Foreign key type compatibility',
              status: 'fail',
              detail: `Column ${sTable.value}.${sCol.value} (${srcField.sqlType}) is incompatible with ${tTable.value}.${tCol.value} (${tgtField.sqlType}).`,
            });
          } else {
            checks.push({
              name: 'Foreign key type compatibility',
              status: 'pass',
              detail: `Column types (${srcField.sqlType} -> ${tgtField.sqlType}) are compatible.`,
            });
          }
          if (!tgtField.isPrimaryKey && !tgtField.isUnique) {
            passed = false;
            checks.push({
              name: 'Target uniqueness check',
              status: 'fail',
              detail: `Referenced column ${tTable.value}.${tCol.value} must be a Primary Key or Unique constraint.`,
            });
          }
        }
      }

      if (op.onDelete === 'CASCADE') {
        elevateRisk('high');
        requiresConfirmText = `CASCADE ${sTable.value}`;
        warnings.push(
          `Cascade delete warning: deleting a row in ${tTable.value} will automatically delete matching rows in ${sTable.value}.`
        );
      } else {
        elevateRisk('medium');
      }

      tsqlChunks.push(
        `ALTER TABLE ${quoteTsqlIdentifier(sSchema.value)}.${quoteTsqlIdentifier(sTable.value)}\n` +
          `  ADD CONSTRAINT ${quoteTsqlIdentifier(cName.value)}\n` +
          `  FOREIGN KEY (${quoteTsqlIdentifier(sCol.value)})\n` +
          `  REFERENCES ${quoteTsqlIdentifier(tSchema.value)}.${quoteTsqlIdentifier(tTable.value)} (${quoteTsqlIdentifier(
            tCol.value
          )})\n` +
          `  ON DELETE ${op.onDelete} ON UPDATE ${op.onUpdate};`
      );
      explanations.push(
        `Links ${sSchema.value}.${sTable.value}.${sCol.value} to ${tSchema.value}.${tTable.value}.${tCol.value} (ON DELETE ${op.onDelete}).`
      );
    } else if (op.kind === 'DROP_FOREIGN_KEY') {
      const cName = validateIdentifier(op.constraintName, 'Constraint name');
      const sName = validateIdentifier(op.schemaName, 'Schema name');
      const tName = validateIdentifier(op.tableName, 'Table name');
      if (!cName.valid) throw new Error(cName.error);
      if (!sName.valid) throw new Error(sName.error);
      if (!tName.valid) throw new Error(tName.error);

      elevateRisk('medium');
      tsqlChunks.push(
        `ALTER TABLE ${quoteTsqlIdentifier(sName.value)}.${quoteTsqlIdentifier(
          tName.value
        )} DROP CONSTRAINT ${quoteTsqlIdentifier(cName.value)};`
      );
      explanations.push(
        `Removes foreign key constraint ${cName.value} from ${sName.value}.${tName.value}.`
      );
    } else if (op.kind === 'ADD_UNIQUE_CONSTRAINT') {
      const cName = validateIdentifier(op.constraintName, 'Constraint name');
      const sName = validateIdentifier(op.schemaName, 'Schema name');
      const tName = validateIdentifier(op.tableName, 'Table name');
      if (!cName.valid) throw new Error(cName.error);
      if (!sName.valid) throw new Error(sName.error);
      if (!tName.valid) throw new Error(tName.error);
      if (!op.columns || op.columns.length === 0) throw new Error('Select at least one column for unique constraint.');

      elevateRisk('low');
      tsqlChunks.push(
        `ALTER TABLE ${quoteTsqlIdentifier(sName.value)}.${quoteTsqlIdentifier(
          tName.value
        )} ADD CONSTRAINT ${quoteTsqlIdentifier(cName.value)} UNIQUE (${op.columns
          .map(quoteTsqlIdentifier)
          .join(', ')});`
      );
      sqliteStatements.push(
        `CREATE UNIQUE INDEX ${quoteSqliteIdentifier(cName.value)} ON ${quoteSqliteQualifiedTable(
          sName.value,
          tName.value
        )} (${op.columns.map(quoteSqliteIdentifier).join(', ')});`
      );
      explanations.push(
        `Adds unique constraint ${cName.value} on ${sName.value}.${tName.value} (${op.columns.join(', ')}).`
      );
    } else if (op.kind === 'ADD_PRIMARY_KEY') {
      const cName = validateIdentifier(op.constraintName, 'Constraint name');
      const sName = validateIdentifier(op.schemaName, 'Schema name');
      const tName = validateIdentifier(op.tableName, 'Table name');
      if (!cName.valid) throw new Error(cName.error);
      if (!sName.valid) throw new Error(sName.error);
      if (!tName.valid) throw new Error(tName.error);
      if (!op.columns || op.columns.length === 0) throw new Error('Select at least one column for Primary Key.');

      elevateRisk('medium');
      tsqlChunks.push(
        `ALTER TABLE ${quoteTsqlIdentifier(sName.value)}.${quoteTsqlIdentifier(
          tName.value
        )} ADD CONSTRAINT ${quoteTsqlIdentifier(cName.value)} PRIMARY KEY CLUSTERED (${op.columns
          .map(quoteTsqlIdentifier)
          .join(', ')});`
      );
      explanations.push(
        `Defines Primary Key ${cName.value} on ${sName.value}.${tName.value} (${op.columns.join(', ')}).`
      );
    } else if (op.kind === 'DROP_CONSTRAINT') {
      const cName = validateIdentifier(op.constraintName, 'Constraint name');
      const sName = validateIdentifier(op.schemaName, 'Schema name');
      const tName = validateIdentifier(op.tableName, 'Table name');
      if (!cName.valid) throw new Error(cName.error);
      if (!sName.valid) throw new Error(sName.error);
      if (!tName.valid) throw new Error(tName.error);

      elevateRisk('high');
      requiresConfirmText = `DROP ${cName.value}`;
      tsqlChunks.push(
        `ALTER TABLE ${quoteTsqlIdentifier(sName.value)}.${quoteTsqlIdentifier(
          tName.value
        )} DROP CONSTRAINT ${quoteTsqlIdentifier(cName.value)};`
      );
      explanations.push(
        `Drops constraint ${cName.value} from ${sName.value}.${tName.value}.`
      );
    } else if (op.kind === 'CREATE_INDEX') {
      const idxName = validateIdentifier(op.indexName, 'Index name');
      const sName = validateIdentifier(op.schemaName, 'Schema name');
      const tName = validateIdentifier(op.tableName, 'Table name');
      if (!idxName.valid) throw new Error(idxName.error);
      if (!sName.valid) throw new Error(sName.error);
      if (!tName.valid) throw new Error(tName.error);
      if (op.columns.length === 0) throw new Error('Select at least one column for the index.');

      const quotedTsqlCols = op.columns.map(quoteTsqlIdentifier).join(', ');
      const quotedSqliteCols = op.columns.map(quoteSqliteIdentifier).join(', ');
      const uniq = op.isUnique ? 'UNIQUE ' : '';

      tsqlChunks.push(
        `CREATE ${uniq}NONCLUSTERED INDEX ${quoteTsqlIdentifier(idxName.value)}\n  ON ${quoteTsqlIdentifier(
          sName.value
        )}.${quoteTsqlIdentifier(tName.value)} (${quotedTsqlCols});`
      );
      sqliteStatements.push(
        `CREATE ${uniq}INDEX ${quoteSqliteIdentifier(idxName.value)} ON ${quoteSqliteQualifiedTable(
          sName.value,
          tName.value
        )} (${quotedSqliteCols});`
      );
      elevateRisk('low');
      explanations.push(
        `Creates ${op.isUnique ? 'unique ' : ''}index ${idxName.value} on ${sName.value}.${tName.value} (${op.columns.join(', ')}).`
      );
    } else if (op.kind === 'DROP_INDEX') {
      const idxName = validateIdentifier(op.indexName, 'Index name');
      const sName = validateIdentifier(op.schemaName, 'Schema name');
      const tName = validateIdentifier(op.tableName, 'Table name');
      if (!idxName.valid) throw new Error(idxName.error);
      if (!sName.valid) throw new Error(sName.error);
      if (!tName.valid) throw new Error(tName.error);

      elevateRisk('medium');
      tsqlChunks.push(
        `DROP INDEX ${quoteTsqlIdentifier(idxName.value)} ON ${quoteTsqlIdentifier(
          sName.value
        )}.${quoteTsqlIdentifier(tName.value)};`
      );
      sqliteStatements.push(`DROP INDEX IF EXISTS ${quoteSqliteIdentifier(idxName.value)};`);
      explanations.push(`Drops index ${idxName.value} from ${sName.value}.${tName.value}.`);
    } else if (op.kind === 'RENAME_OBJECT') {
      const sName = validateIdentifier(op.schemaName, 'Schema name');
      const tName = validateIdentifier(op.tableName, 'Table name');
      const newCheck = validateIdentifier(op.newName, 'New name');
      if (!sName.valid) throw new Error(sName.error);
      if (!tName.valid) throw new Error(tName.error);
      if (!newCheck.valid) throw new Error(newCheck.error);

      elevateRisk('medium');
      if (op.columnName) {
        const cCheck = validateIdentifier(op.columnName, 'Column name');
        if (!cCheck.valid) throw new Error(cCheck.error);
        tsqlChunks.push(
          `EXEC sp_rename N'${sName.value}.${tName.value}.${cCheck.value}', N'${newCheck.value}', N'COLUMN';`
        );
        sqliteStatements.push(
          `ALTER TABLE ${quoteSqliteQualifiedTable(sName.value, tName.value)} RENAME COLUMN ${quoteSqliteIdentifier(
            cCheck.value
          )} TO ${quoteSqliteIdentifier(newCheck.value)};`
        );
        explanations.push(
          `Renames column ${sName.value}.${tName.value}.${cCheck.value} to ${newCheck.value}.`
        );
      } else {
        tsqlChunks.push(
          `EXEC sp_rename N'${sName.value}.${tName.value}', N'${newCheck.value}';`
        );
        sqliteStatements.push(
          `ALTER TABLE ${quoteSqliteQualifiedTable(sName.value, tName.value)} RENAME TO ${quoteSqliteQualifiedTable(
            sName.value,
            newCheck.value
          )};`
        );
        explanations.push(`Renames table ${sName.value}.${tName.value} to ${sName.value}.${newCheck.value}.`);
      }
    } else if (op.kind === 'CREATE_DATABASE') {
      const dbCheck = validateIdentifier(op.databaseName, 'Database name');
      if (!dbCheck.valid) throw new Error(dbCheck.error);
      const collationSql = op.collation && validateIdentifier(op.collation, 'Collation').valid
        ? ` COLLATE ${op.collation.trim()}`
        : '';
      elevateRisk('medium');
      tsqlChunks.push(`CREATE DATABASE ${quoteTsqlIdentifier(dbCheck.value)}${collationSql};`);
      explanations.push(`Creates SQL Server database ${dbCheck.value}.`);
    }
  }

  return {
    tsql: tsqlChunks.join('\n\n'),
    sqliteStatements,
    plainExplanation: explanations.join(' '),
    riskLevel,
    requiresConfirmText,
    preflight: {
      passed,
      checks,
      warnings,
      requiredPermissions: ['ALTER / CREATE TABLE on target schema'],
      estimatedImpact: `${operations.length} schema operation${operations.length === 1 ? '' : 's'} · Risk: ${riskLevel}`,
    },
  };
}

export function compileVisualQuery(
  spec: VisualQuerySpec,
  dialect: 'tsql' | 'sqlite'
): { sql: string; params: Record<string, unknown>; orderedParams: unknown[] } {
  const sCheck = validateIdentifier(spec.schemaName, 'Schema');
  const tCheck = validateIdentifier(spec.tableName, 'Table');
  if (!sCheck.valid) throw new Error(sCheck.error);
  if (!tCheck.valid) throw new Error(tCheck.error);

  const hasAggregates = Boolean(spec.aggregates && spec.aggregates.length > 0);
  if ((!spec.columns || spec.columns.length === 0) && !hasAggregates) {
    throw new Error('Select at least one column or aggregate to query.');
  }

  const q = dialect === 'tsql' ? quoteTsqlIdentifier : quoteSqliteIdentifier;
  const baseRef =
    dialect === 'tsql'
      ? `${q(sCheck.value)}.${q(tCheck.value)}`
      : quoteSqliteQualifiedTable(sCheck.value, tCheck.value);
  const baseAlias = 't0';

  const hasJoins = Boolean(spec.joins && spec.joins.length > 0);
  const qualifyBaseCol = (col: string) =>
    hasJoins ? `${baseAlias}.${q(col)}` : q(col);

  const selectItems: string[] = [];
  for (const col of spec.columns || []) {
    if (col.includes('.')) {
      const [tbl, colName] = col.split('.', 2);
      selectItems.push(`${q(tbl)}.${q(colName)}`);
    } else {
      selectItems.push(qualifyBaseCol(col));
    }
  }

  if (spec.aggregates) {
    for (const agg of spec.aggregates) {
      const aliasCheck = validateIdentifier(agg.alias, 'Aggregate alias');
      if (!aliasCheck.valid) throw new Error(aliasCheck.error);
      const colExpr = agg.column === '*' ? '*' : qualifyBaseCol(agg.column);
      selectItems.push(`${agg.func}(${colExpr}) AS ${q(aliasCheck.value)}`);
    }
  }

  let joinSql = '';
  if (spec.joins && spec.joins.length > 0) {
    joinSql = spec.joins
      .map((j, idx) => {
        const js = validateIdentifier(j.targetSchema, 'Joined schema');
        const jt = validateIdentifier(j.targetTable, 'Joined table');
        if (!js.valid) throw new Error(js.error);
        if (!jt.valid) throw new Error(jt.error);
        const jAlias = `j${idx + 1}`;
        const jTableSql =
          dialect === 'tsql'
            ? `${q(js.value)}.${q(jt.value)}`
            : quoteSqliteQualifiedTable(js.value, jt.value);
        const joinKw = j.joinType === 'LEFT' ? 'LEFT JOIN' : 'INNER JOIN';
        return `\n${joinKw} ${jTableSql} AS ${jAlias} ON ${baseAlias}.${q(j.sourceColumn)} = ${jAlias}.${q(j.targetColumn)}`;
      })
      .join('');
  }

  const whereParts: string[] = [];
  const params: Record<string, unknown> = {};
  const orderedParams: unknown[] = [];

  spec.filters.forEach((f, idx) => {
    const colSql = qualifyBaseCol(f.column);
    const paramName = `p${idx}`;
    if (f.operator === 'is_null') {
      whereParts.push(`${colSql} IS NULL`);
    } else if (f.operator === 'is_not_null') {
      whereParts.push(`${colSql} IS NOT NULL`);
    } else if (f.operator === 'contains') {
      const val = `%${f.value}%`;
      if (dialect === 'tsql') {
        whereParts.push(`${colSql} LIKE @${paramName}`);
      } else {
        whereParts.push(`${colSql} LIKE ?`);
      }
      params[paramName] = val;
      orderedParams.push(val);
    } else {
      const opMap: Record<'eq' | 'neq' | 'gt' | 'lt', string> = {
        eq: '=',
        neq: '!=',
        gt: '>',
        lt: '<',
      };
      const sqlOp = opMap[f.operator];
      if (dialect === 'tsql') {
        whereParts.push(`${colSql} ${sqlOp} @${paramName}`);
      } else {
        whereParts.push(`${colSql} ${sqlOp} ?`);
      }
      params[paramName] = f.value;
      orderedParams.push(f.value);
    }
  });

  const safeLimit = Math.min(Math.max(Math.floor(spec.limit || 50), 1), 1000);
  const whereSql = whereParts.length > 0 ? `\nWHERE ${whereParts.join(' AND ')}` : '';
  const groupSql =
    spec.groupBy && spec.groupBy.length > 0
      ? `\nGROUP BY ${spec.groupBy.map(qualifyBaseCol).join(', ')}`
      : '';
  const orderSql = spec.orderBy
    ? `\nORDER BY ${qualifyBaseCol(spec.orderBy.column)} ${spec.orderBy.direction === 'DESC' ? 'DESC' : 'ASC'}`
    : '';
  const fromClause = hasJoins ? `${baseRef} AS ${baseAlias}${joinSql}` : baseRef;

  if (dialect === 'tsql') {
    return {
      sql: `SELECT TOP (${safeLimit}) ${selectItems.join(', ')}\nFROM ${fromClause}${whereSql}${groupSql}${orderSql};`,
      params,
      orderedParams,
    };
  }
  return {
    sql: `SELECT ${selectItems.join(', ')}\nFROM ${fromClause}${whereSql}${groupSql}${orderSql}\nLIMIT ${safeLimit};`,
    params,
    orderedParams,
  };
}

export function validateSqlStatement(
  rawSql: string,
  allowMutations: boolean
): {
  valid: boolean;
  statementType: 'SELECT' | 'EXPLAIN' | 'MUTATION';
  error?: string;
} {
  const cleaned = rawSql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();

  if (!cleaned) {
    return { valid: false, statementType: 'SELECT', error: 'Enter a SQL statement before running.' };
  }

  const withoutTrailingSemi = cleaned.replace(/;+$/, '');
  if (withoutTrailingSemi.includes(';')) {
    return {
      valid: false,
      statementType: 'MUTATION',
      error: 'Execute one statement at a time in the SQL Editor; multi-statement batches belong in reviewed Change Plans.',
    };
  }

  const forbiddenServerOps = /\b(xp_cmdshell|sp_configure|OPENROWSET|OPENDATASOURCE|SHUTDOWN|DROP\s+DATABASE|ALTER\s+DATABASE|CREATE\s+LOGIN|ALTER\s+LOGIN|GRANT\s+CONTROL)\b/i;
  if (forbiddenServerOps.test(withoutTrailingSemi)) {
    return {
      valid: false,
      statementType: 'MUTATION',
      error: 'Server-level administration commands (xp_cmdshell, sp_configure, DROP DATABASE, login grants) are blocked by policy.',
    };
  }

  const isSelect = /^\s*(SELECT|WITH)\b/i.test(withoutTrailingSemi);
  const isExplain = /^\s*(EXPLAIN|SET\s+SHOWPLAN)/i.test(withoutTrailingSemi);

  if (isSelect) {
    return { valid: true, statementType: 'SELECT' };
  }
  if (isExplain) {
    return { valid: true, statementType: 'EXPLAIN' };
  }

  if (!allowMutations) {
    return {
      valid: false,
      statementType: 'MUTATION',
      error: 'Connection or role is currently Read-Only. Enable Write Access or route schema changes through the Change Center.',
    };
  }

  return { valid: true, statementType: 'MUTATION' };
}

export function formatSql(rawSql: string): string {
  const trimmed = rawSql.trim();
  if (!trimmed) return '';

  // Tokenize preserving single-quoted strings and bracketed identifiers
  const tokens: Array<{ type: 'literal' | 'code'; value: string }> = [];
  let idx = 0;
  let buf = '';
  while (idx < trimmed.length) {
    const ch = trimmed[idx];
    if (ch === "'" || ch === '[' || ch === '"') {
      if (buf) {
        tokens.push({ type: 'code', value: buf });
        buf = '';
      }
      const endCh = ch === '[' ? ']' : ch;
      let end = idx + 1;
      while (end < trimmed.length) {
        if (trimmed[end] === endCh) {
          if (ch === "'" && trimmed[end + 1] === "'") {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
      tokens.push({ type: 'literal', value: trimmed.slice(idx, end) });
      idx = end;
    } else {
      buf += ch;
      idx += 1;
    }
  }
  if (buf) tokens.push({ type: 'code', value: buf });

  const majorKeywords = [
    'SELECT',
    'FROM',
    'INNER JOIN',
    'LEFT JOIN',
    'RIGHT JOIN',
    'FULL JOIN',
    'JOIN',
    'WHERE',
    'GROUP BY',
    'HAVING',
    'ORDER BY',
    'OFFSET',
    'UNION ALL',
    'UNION',
    'INSERT INTO',
    'VALUES',
    'UPDATE',
    'SET',
    'DELETE FROM',
  ];

  const upperWords = new Set([
    ...majorKeywords,
    'AS',
    'ON',
    'AND',
    'OR',
    'NOT',
    'NULL',
    'IS',
    'IN',
    'LIKE',
    'TOP',
    'DISTINCT',
    'COUNT',
    'SUM',
    'AVG',
    'MIN',
    'MAX',
    'ASC',
    'DESC',
    'CASE',
    'WHEN',
    'THEN',
    'ELSE',
    'END',
    'WITH',
    'ROWS',
    'FETCH',
    'NEXT',
    'ONLY',
    'LIMIT',
  ]);

  let formatted = tokens
    .map((tok) => {
      if (tok.type === 'literal') return tok.value;
      let text = tok.value.replace(/\s+/g, ' ');
      for (const kw of upperWords) {
        const re = new RegExp(`\\b${kw.replace(/\s+/g, '\\s+')}\\b`, 'gi');
        text = text.replace(re, kw);
      }
      return text;
    })
    .join('');

  for (const kw of majorKeywords) {
    const re = new RegExp(`\\s+(${kw.replace(/\s+/g, '\\s+')})\\b`, 'g');
    formatted = formatted.replace(re, `\n$1`);
  }
  formatted = formatted
    .replace(/\s+\b(AND|OR)\b\s+/g, '\n  $1 ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  return formatted;
}

export function explainSqlError(rawError: string): SqlErrorExplanation {
  const msg = rawError || '';

  if (/18456|Login failed for user/i.test(msg)) {
    return {
      code: 18456,
      title: 'SQL Server Login Rejected',
      summary: 'SQL Server rejected the username, password, or login authentication mode.',
      suggestion:
        'Verify Mixed Mode Authentication is enabled on SQL Server for SQL logins, check username/password, or switch to Windows Authentication.',
    };
  }
  if (/208|Invalid object name|no such table/i.test(msg)) {
    return {
      code: 208,
      title: 'Table or View Not Found',
      summary: 'The referenced schema, table, or view does not exist in the active database.',
      suggestion:
        'Refresh schema metadata, verify the schema prefix (for example [dbo].[TableName]), and ensure you connected to the intended database.',
    };
  }
  if (/207|Invalid column name|no such column/i.test(msg)) {
    return {
      code: 207,
      title: 'Unknown Column Name',
      summary: 'One or more columns referenced in your query or filter do not exist in the table.',
      suggestion: 'Check column spelling and casing in Database Explorer before re-running.',
    };
  }
  if (/547|FOREIGN KEY constraint|conflicted with the REFERENCE constraint/i.test(msg)) {
    return {
      code: 547,
      title: 'Foreign Key Referential Integrity Conflict',
      summary: 'This insert, update, or delete violates a parent/child Foreign Key relationship.',
      suggestion:
        'Ensure referenced parent IDs exist first, or update/remove child records before deleting the parent record.',
    };
  }
  if (/2627|2601|UNIQUE constraint|duplicate key/i.test(msg)) {
    return {
      code: 2627,
      title: 'Duplicate Primary or Unique Key',
      summary: 'A record with the same Primary Key or Unique column value already exists.',
      suggestion: 'Provide a distinct key value or edit the existing row instead of inserting a duplicate.',
    };
  }
  if (/515|Cannot insert the value NULL|NOT NULL constraint/i.test(msg)) {
    return {
      code: 515,
      title: 'Required Field Cannot Be Empty (NULL)',
      summary: 'A column marked NOT NULL without a default value was omitted or left blank.',
      suggestion: 'Fill in all required fields marked NOT NULL before saving.',
    };
  }
  if (/229|permission was denied/i.test(msg)) {
    return {
      code: 229,
      title: 'Insufficient SQL Server Permissions',
      summary: 'Your SQL Server login lacks SELECT, INSERT, UPDATE, DELETE, or ALTER permissions on this object.',
      suggestion: 'Request least-privilege grant on the schema/table from your DBA or connect with an authorized role.',
    };
  }
  if (/certificate|self signed|TLS|SSL/i.test(msg)) {
    return {
      code: null,
      title: 'TLS Certificate Validation Failed',
      summary: 'The SQL Server TLS certificate is untrusted, expired, or does not match the hostname.',
      suggestion:
        'Install a trusted CA certificate on SQL Server, or for local/dev instances explicitly opt into "Trust self-signed server certificate".',
    };
  }
  if (/ETIMEDOUT|ECONNREFUSED|ESOCKET|timeout|Unreachable/i.test(msg)) {
    return {
      code: null,
      title: 'Network Reachability or Timeout Error',
      summary: 'Could not reach the SQL Server TCP port or query exceeded the configured timeout.',
      suggestion:
        'Verify SQL Server TCP/IP is enabled, check Windows Firewall port 1433 / SQL Browser UDP 1434, or route through the Windows Connector Agent.',
    };
  }

  return {
    code: null,
    title: 'Database Execution Error',
    summary: msg || 'The database engine returned an error executing the statement.',
    suggestion: 'Inspect the SQL syntax, table names, permissions, and connection state before retrying.',
  };
}

export function diffSchemaSnapshots(
  targetFingerprint: string,
  baselineSnapshot: SchemaSnapshot | null,
  liveSnapshot: SchemaSnapshot
): SchemaDriftReport {
  const checkedAt = new Date().toISOString();
  if (targetFingerprint === liveSnapshot.fingerprint) {
    return {
      drifted: false,
      targetFingerprint,
      liveFingerprint: liveSnapshot.fingerprint,
      checkedAt,
      addedTables: [],
      removedTables: [],
      changedTables: [],
      summary: 'No schema drift detected. Live database metadata matches the staged plan fingerprint.',
    };
  }

  if (!baselineSnapshot) {
    return {
      drifted: true,
      targetFingerprint,
      liveFingerprint: liveSnapshot.fingerprint,
      checkedAt,
      addedTables: [],
      removedTables: [],
      changedTables: [],
      summary: `Schema fingerprint changed (${targetFingerprint} -> ${liveSnapshot.fingerprint}). Re-validate plan against live metadata.`,
    };
  }

  const baseMap = new Map(baselineSnapshot.tables.map((t) => [t.fullName.toLowerCase(), t]));
  const liveMap = new Map(liveSnapshot.tables.map((t) => [t.fullName.toLowerCase(), t]));

  const addedTables: string[] = [];
  const removedTables: string[] = [];
  const changedTables: SchemaDriftReport['changedTables'] = [];

  for (const [k, liveTbl] of liveMap.entries()) {
    const baseTbl = baseMap.get(k);
    if (!baseTbl) {
      addedTables.push(liveTbl.fullName);
      continue;
    }
    const baseCols = new Map(baseTbl.columns.map((c) => [c.name.toLowerCase(), c]));
    const liveCols = new Map(liveTbl.columns.map((c) => [c.name.toLowerCase(), c]));
    const addedColumns: string[] = [];
    const removedColumns: string[] = [];
    const alteredColumns: string[] = [];

    for (const [ck, lc] of liveCols.entries()) {
      const bc = baseCols.get(ck);
      if (!bc) addedColumns.push(lc.name);
      else if (bc.sqlType !== lc.sqlType || bc.nullable !== lc.nullable) alteredColumns.push(lc.name);
    }
    for (const [ck, bc] of baseCols.entries()) {
      if (!liveCols.has(ck)) removedColumns.push(bc.name);
    }

    if (addedColumns.length || removedColumns.length || alteredColumns.length) {
      changedTables.push({
        fullName: liveTbl.fullName,
        addedColumns,
        removedColumns,
        alteredColumns,
      });
    }
  }

  for (const [k, baseTbl] of baseMap.entries()) {
    if (!liveMap.has(k)) removedTables.push(baseTbl.fullName);
  }

  return {
    drifted: true,
    targetFingerprint,
    liveFingerprint: liveSnapshot.fingerprint,
    checkedAt,
    addedTables,
    removedTables,
    changedTables,
    summary: `Drift detected (${targetFingerprint} -> ${liveSnapshot.fingerprint}): ${addedTables.length} added table(s), ${removedTables.length} removed table(s), ${changedTables.length} modified table(s).`,
  };
}

export function generateSchemaMarkdownDocs(snapshot: SchemaSnapshot): string {
  const lines: string[] = [
    `# Database Data Dictionary: ${snapshot.databaseName}`,
    '',
    `- **Engine**: ${snapshot.engineVersion}`,
    `- **Captured At**: ${snapshot.capturedAt}`,
    `- **Schema Fingerprint**: \`${snapshot.fingerprint}\``,
    `- **Tables & Views**: ${snapshot.tables.length}`,
    '',
  ];

  for (const table of snapshot.tables) {
    lines.push(`## ${table.fullName} (${table.objectType})`);
    lines.push('');
    lines.push(`- Estimated Rows: ${table.rowCountEstimate.toLocaleString()}`);
    lines.push(`- Primary Key: ${table.primaryKeyColumns.length ? table.primaryKeyColumns.join(', ') : 'None'}`);
    lines.push('');
    lines.push('| Column | SQL Type | Friendly Type | Nullable | Keys / Flags | Default |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const col of table.columns) {
      const flags = [
        col.isPrimaryKey ? 'PK' : '',
        col.isIdentity ? 'IDENTITY' : '',
        col.isUnique && !col.isPrimaryKey ? 'UNIQUE' : '',
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(
        `| ${col.name} | \`${col.sqlType}\` | ${col.friendlyType} | ${col.nullable ? 'YES' : 'NO'} | ${flags || '-'} | ${col.defaultValue ?? '-'} |`
      );
    }
    if (table.foreignKeys.length > 0) {
      lines.push('');
      lines.push('**Relationships:**');
      for (const fk of table.foreignKeys) {
        lines.push(
          `- \`${fk.name}\`: \`${fk.sourceColumn}\` -> \`${fk.targetSchema}.${fk.targetTable}.${fk.targetColumn}\` (ON DELETE ${fk.onDelete})`
        );
      }
    }
    if (table.indexes.length > 0) {
      lines.push('');
      lines.push('**Indexes:**');
      for (const idx of table.indexes) {
        lines.push(
          `- \`${idx.name}\` (${idx.type}${idx.isUnique ? ', UNIQUE' : ''}): \`${idx.columns.join(', ')}\``
        );
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function computeDeterministicDigest(payload: string): Promise<string> {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const bytes = new TextEncoder().encode(payload);
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);
  }
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < payload.length; i += 1) {
    h ^= BigInt(payload.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, '0');
}
