import {
  FieldDraft,
  FieldTypeMapping,
  FriendlyFieldType,
  PreflightReport,
  RiskLevel,
  SchemaOperation,
  SchemaSnapshot,
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
    description: 'Financial amounts stored with exact 2-decimal precision.',
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

export function mapFriendlyToSqlServerType(field: FieldDraft): string {
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

        // Sandbox SQLite DDL equivalent
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
      // Note: SQLite requires table rebuild for ALTER ADD CONSTRAINT, so sandbox records FK metadata safely
      explanations.push(
        `Links ${sSchema.value}.${sTable.value}.${sCol.value} to ${tSchema.value}.${tTable.value}.${tCol.value} (ON DELETE ${op.onDelete}).`
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
  if (!spec.columns || spec.columns.length === 0) {
    throw new Error('Select at least one column to query.');
  }

  const q = dialect === 'tsql' ? quoteTsqlIdentifier : quoteSqliteIdentifier;
  const colList = spec.columns.map((c) => q(c)).join(', ');
  const fromClause =
    dialect === 'tsql'
      ? `${q(sCheck.value)}.${q(tCheck.value)}`
      : quoteSqliteQualifiedTable(sCheck.value, tCheck.value);

  const whereParts: string[] = [];
  const params: Record<string, unknown> = {};
  const orderedParams: unknown[] = [];

  spec.filters.forEach((f, idx) => {
    const colSql = q(f.column);
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

  const safeLimit = Math.min(Math.max(Math.floor(spec.limit || 50), 1), 500);
  const whereSql = whereParts.length > 0 ? `\nWHERE ${whereParts.join(' AND ')}` : '';
  const orderSql = spec.orderBy
    ? `\nORDER BY ${q(spec.orderBy.column)} ${spec.orderBy.direction === 'DESC' ? 'DESC' : 'ASC'}`
    : '';

  if (dialect === 'tsql') {
    return {
      sql: `SELECT TOP (${safeLimit}) ${colList}\nFROM ${fromClause}${whereSql}${orderSql};`,
      params,
      orderedParams,
    };
  }
  return {
    sql: `SELECT ${colList}\nFROM ${fromClause}${whereSql}${orderSql}\nLIMIT ${safeLimit};`,
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

  // Disallow multi-statement injection batches from the ad-hoc editor
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

export async function computeDeterministicDigest(payload: string): Promise<string> {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const bytes = new TextEncoder().encode(payload);
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);
  }
  // Fallback FNV-1a deterministic 64-bit hex if subtle unavailable
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < payload.length; i += 1) {
    h ^= BigInt(payload.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, '0');
}
