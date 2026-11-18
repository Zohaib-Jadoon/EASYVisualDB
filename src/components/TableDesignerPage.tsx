import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Plus,
  Trash2,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  compileOperationsPlan,
  FRIENDLY_FIELD_TYPES,
} from '../shared/sqlCompiler';
import {
  AppMode,
  ConnectionProfile,
  FieldDraft,
  FriendlyFieldType,
  SchemaOperation,
  SchemaSnapshot,
} from '../shared/types';
import { NavSection } from './AppShell';

interface TableDesignerPageProps {
  mode: AppMode;
  connection: ConnectionProfile | null;
  snapshot: SchemaSnapshot | null;
  onPlanCreated: () => Promise<void>;
  onNavigate: (nav: NavSection) => void;
  onToast: (tone: 'success' | 'error' | 'info', title: string, detail?: string) => void;
}

type AlterOperationKind =
  | 'ADD_COLUMN'
  | 'ALTER_COLUMN'
  | 'DROP_COLUMN'
  | 'ADD_PRIMARY_KEY'
  | 'ADD_UNIQUE_CONSTRAINT'
  | 'DROP_CONSTRAINT'
  | 'CREATE_INDEX'
  | 'DROP_INDEX';

const STARTER_TEMPLATES: Record<string, { tableName: string; fields: FieldDraft[] }> = {
  blank: {
    tableName: '',
    fields: [
      {
        id: 'f_1',
        name: 'ID',
        friendlyType: 'auto_id',
        nullable: false,
        isPrimaryKey: true,
        isIdentity: true,
        isUnique: true,
      },
      {
        id: 'f_2',
        name: 'Name',
        friendlyType: 'text',
        length: 120,
        nullable: false,
        isPrimaryKey: false,
        isIdentity: false,
        isUnique: false,
      },
    ],
  },
  invoices: {
    tableName: 'Invoices',
    fields: [
      { id: 'i_1', name: 'InvoiceID', friendlyType: 'auto_id', nullable: false, isPrimaryKey: true, isIdentity: true, isUnique: true },
      { id: 'i_2', name: 'InvoiceNumber', friendlyType: 'text', length: 40, nullable: false, isPrimaryKey: false, isIdentity: false, isUnique: true },
      { id: 'i_3', name: 'TotalAmount', friendlyType: 'money', nullable: false, isPrimaryKey: false, isIdentity: false, isUnique: false },
      { id: 'i_4', name: 'IssuedDate', friendlyType: 'date', nullable: false, isPrimaryKey: false, isIdentity: false, isUnique: false },
      { id: 'i_5', name: 'IsPaid', friendlyType: 'boolean', nullable: false, isPrimaryKey: false, isIdentity: false, isUnique: false, defaultValue: '0' },
    ],
  },
  inventory: {
    tableName: 'InventoryItems',
    fields: [
      { id: 'inv_1', name: 'ItemID', friendlyType: 'auto_id', nullable: false, isPrimaryKey: true, isIdentity: true, isUnique: true },
      { id: 'inv_2', name: 'SKU', friendlyType: 'text', length: 64, nullable: false, isPrimaryKey: false, isIdentity: false, isUnique: true },
      { id: 'inv_3', name: 'ItemName', friendlyType: 'text', length: 160, nullable: false, isPrimaryKey: false, isIdentity: false, isUnique: false },
      { id: 'inv_4', name: 'QuantityOnHand', friendlyType: 'integer', nullable: false, isPrimaryKey: false, isIdentity: false, isUnique: false, defaultValue: '0' },
      { id: 'inv_5', name: 'UnitPrice', friendlyType: 'money', nullable: false, isPrimaryKey: false, isIdentity: false, isUnique: false },
    ],
  },
};

export function TableDesignerPage({
  mode,
  connection,
  snapshot,
  onPlanCreated,
  onNavigate,
  onToast,
}: TableDesignerPageProps) {
  const [designAction, setDesignAction] = useState<'create' | 'alter'>('create');
  const [schemaName, setSchemaName] = useState('dbo');
  const [tableName, setTableName] = useState('');
  const [fields, setFields] = useState<FieldDraft[]>(STARTER_TEMPLATES.blank.fields);

  // Alter existing table state
  const [alterTableKey, setAlterTableKey] = useState(snapshot?.tables[0]?.fullName ?? '');
  const [alterKind, setAlterKind] = useState<AlterOperationKind>('ADD_COLUMN');
  const [newCol, setNewCol] = useState<FieldDraft>({
    id: 'alter_col',
    name: '',
    friendlyType: 'text',
    length: 120,
    nullable: true,
    isPrimaryKey: false,
    isIdentity: false,
    isUnique: false,
  });
  const [alterColName, setAlterColName] = useState('');
  const [alterColType, setAlterColType] = useState<FriendlyFieldType>('text');
  const [alterColLength, setAlterColLength] = useState<number>(200);
  const [alterColNullable, setAlterColNullable] = useState<boolean>(true);
  const [dropColName, setDropColName] = useState('');
  const [constraintName, setConstraintName] = useState('');
  const [selectedConstraintCols, setSelectedConstraintCols] = useState<string[]>([]);
  const [uniqueIndexFlag, setUniqueIndexFlag] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const alterTargetTable =
    snapshot?.tables.find((t) => t.fullName === alterTableKey) ?? snapshot?.tables[0] ?? null;

  const operations: SchemaOperation[] = useMemo(() => {
    if (designAction === 'create') {
      return [
        {
          kind: 'CREATE_TABLE',
          schemaName: schemaName || 'dbo',
          tableName: tableName || 'NewTable',
          fields,
        },
      ];
    }
    if (!alterTargetTable) return [];
    const fallbackCol = alterTargetTable.columns[0]?.name ?? 'Column';
    const pickedCols =
      selectedConstraintCols.length > 0 ? selectedConstraintCols : [fallbackCol];

    switch (alterKind) {
      case 'ADD_COLUMN':
        return [
          {
            kind: 'ADD_COLUMN',
            schemaName: alterTargetTable.schemaName,
            tableName: alterTargetTable.tableName,
            field: { ...newCol, name: newCol.name || 'NewColumn' },
          },
        ];
      case 'ALTER_COLUMN':
        return [
          {
            kind: 'ALTER_COLUMN',
            schemaName: alterTargetTable.schemaName,
            tableName: alterTargetTable.tableName,
            columnName: alterColName || fallbackCol,
            friendlyType: alterColType,
            length: alterColType === 'text' ? alterColLength : undefined,
            nullable: alterColNullable,
          },
        ];
      case 'DROP_COLUMN':
        return [
          {
            kind: 'DROP_COLUMN',
            schemaName: alterTargetTable.schemaName,
            tableName: alterTargetTable.tableName,
            columnName:
              dropColName ||
              alterTargetTable.columns[alterTargetTable.columns.length - 1]?.name ||
              'Column',
          },
        ];
      case 'ADD_PRIMARY_KEY':
        return [
          {
            kind: 'ADD_PRIMARY_KEY',
            constraintName:
              constraintName.trim() || `PK_${alterTargetTable.tableName}_${pickedCols[0]}`,
            schemaName: alterTargetTable.schemaName,
            tableName: alterTargetTable.tableName,
            columns: pickedCols,
          },
        ];
      case 'ADD_UNIQUE_CONSTRAINT':
        return [
          {
            kind: 'ADD_UNIQUE_CONSTRAINT',
            constraintName:
              constraintName.trim() || `UQ_${alterTargetTable.tableName}_${pickedCols.join('_')}`,
            schemaName: alterTargetTable.schemaName,
            tableName: alterTargetTable.tableName,
            columns: pickedCols,
          },
        ];
      case 'DROP_CONSTRAINT':
        return [
          {
            kind: 'DROP_CONSTRAINT',
            constraintName: constraintName.trim() || 'ConstraintName',
            schemaName: alterTargetTable.schemaName,
            tableName: alterTargetTable.tableName,
          },
        ];
      case 'CREATE_INDEX':
        return [
          {
            kind: 'CREATE_INDEX',
            indexName:
              constraintName.trim() || `IX_${alterTargetTable.tableName}_${pickedCols.join('_')}`,
            schemaName: alterTargetTable.schemaName,
            tableName: alterTargetTable.tableName,
            columns: pickedCols,
            isUnique: uniqueIndexFlag,
          },
        ];
      case 'DROP_INDEX':
        return [
          {
            kind: 'DROP_INDEX',
            indexName:
              constraintName.trim() ||
              alterTargetTable.indexes[0]?.name ||
              `IX_${alterTargetTable.tableName}`,
            schemaName: alterTargetTable.schemaName,
            tableName: alterTargetTable.tableName,
          },
        ];
    }
  }, [
    designAction,
    schemaName,
    tableName,
    fields,
    alterTargetTable,
    alterKind,
    newCol,
    alterColName,
    alterColType,
    alterColLength,
    alterColNullable,
    dropColName,
    constraintName,
    selectedConstraintCols,
    uniqueIndexFlag,
  ]);

  const previewResult = useMemo(() => {
    if (operations.length === 0) return { ok: false as const, error: 'Select a target table.' };
    try {
      const compiled = compileOperationsPlan(operations, snapshot);
      return { ok: true as const, compiled };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : 'Invalid field configuration.',
      };
    }
  }, [operations, snapshot]);

  if (!connection) {
    return (
      <div className="max-w-3xl mx-auto rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-8 text-center space-y-3">
        <h2 className="font-display text-lg font-semibold text-[#1B2340] dark:text-white">
          Connect a database to design tables
        </h2>
        <p className="text-xs text-slate-500">
          Open Connections to link a SQL Server instance or load the interactive sample sandbox.
        </p>
        <button
          type="button"
          onClick={() => onNavigate('connections')}
          className="px-4 py-2 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium"
        >
          Go to Connections
        </button>
      </div>
    );
  }

  const addField = () => {
    setFields((prev) => [
      ...prev,
      {
        id: `f_${Date.now()}_${prev.length}`,
        name: `Field${prev.length + 1}`,
        friendlyType: 'text',
        length: 120,
        nullable: true,
        isPrimaryKey: false,
        isIdentity: false,
        isUnique: false,
      },
    ]);
  };

  const updateField = (id: string, patch: Partial<FieldDraft>) => {
    setFields((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        const next = { ...f, ...patch };
        if (patch.friendlyType === 'auto_id') {
          next.isIdentity = true;
          next.isPrimaryKey = true;
          next.nullable = false;
          next.isUnique = true;
        } else if (patch.friendlyType) {
          next.isIdentity = false;
        }
        return next;
      })
    );
  };

  const moveField = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= fields.length) return;
    const copy = [...fields];
    const [item] = copy.splice(index, 1);
    copy.splice(target, 0, item);
    setFields(copy);
  };

  const handleStagePlan = async () => {
    if (designAction === 'create' && !tableName.trim()) {
      onToast('error', 'Table name required', 'Enter a valid table name such as Projects or Orders.');
      return;
    }
    if (designAction === 'alter' && alterKind === 'ADD_COLUMN' && !newCol.name.trim()) {
      onToast('error', 'Column name required', 'Enter a name for the new field.');
      return;
    }
    setSubmitting(true);
    try {
      const title =
        designAction === 'create'
          ? `Create table ${schemaName}.${tableName.trim()}`
          : `${alterKind.replace(/_/g, ' ')} on ${alterTargetTable?.fullName}`;
      await api.createPlan(connection.id, title, operations);
      await onPlanCreated();
      onToast('success', 'Change plan staged', 'Review the SQL script and preflight checks in Change Center.');
      onNavigate('changes');
    } catch (err) {
      onToast('error', 'Could not stage change plan', err instanceof Error ? err.message : 'Validation failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[#1B2340] dark:text-white">
            {mode === 'simple' ? 'Visual Table & Index Builder' : 'DDL Table, Constraint & Index Designer'}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Design tables, alter columns, manage primary/unique constraints and indexes, and preview exact T-SQL before staging.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg bg-[#F1F3F9] dark:bg-[#181F38] border border-[#E2E6F0] dark:border-[#232B45]">
          <button
            type="button"
            onClick={() => setDesignAction('create')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${
              designAction === 'create'
                ? 'bg-white dark:bg-[#12172B] text-[#6D4AFF] shadow-xs'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            New Table
          </button>
          <button
            type="button"
            onClick={() => setDesignAction('alter')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${
              designAction === 'alter'
                ? 'bg-white dark:bg-[#12172B] text-[#6D4AFF] shadow-xs'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            Modify Columns, Keys & Indexes
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <section className="xl:col-span-7 rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-5">
          {designAction === 'create' ? (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-28">
                  <label htmlFor="tb-schema" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Schema
                  </label>
                  <input
                    id="tb-schema"
                    type="text"
                    value={schemaName}
                    onChange={(e) => setSchemaName(e.target.value)}
                    className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm font-mono text-[#1B2340] dark:text-white"
                  />
                </div>
                <div className="flex-1 min-w-[200px]">
                  <label htmlFor="tb-name" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Table Name
                  </label>
                  <input
                    id="tb-name"
                    type="text"
                    placeholder="e.g. CustomerInvoices"
                    value={tableName}
                    onChange={(e) => setTableName(e.target.value)}
                    className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm text-[#1B2340] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
                  />
                </div>
                <div>
                  <label htmlFor="tb-tpl" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Starter Template
                  </label>
                  <select
                    id="tb-tpl"
                    onChange={(e) => {
                      const tpl = STARTER_TEMPLATES[e.target.value];
                      if (tpl) {
                        if (tpl.tableName) setTableName(tpl.tableName);
                        setFields(tpl.fields.map((f, idx) => ({ ...f, id: `tpl_${Date.now()}_${idx}` })));
                      }
                    }}
                    className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-xs text-[#1B2340] dark:text-white"
                  >
                    <option value="blank">Blank Table</option>
                    <option value="invoices">Invoices Template</option>
                    <option value="inventory">Inventory Items</option>
                  </select>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#1B2340] dark:text-white">
                    {mode === 'simple' ? 'Fields' : 'Column Definitions'}
                  </span>
                  <button
                    type="button"
                    onClick={addField}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#6D4AFF]/10 text-[#6D4AFF] dark:text-[#A692FF] text-xs font-medium hover:bg-[#6D4AFF]/20"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Add field</span>
                  </button>
                </div>

                <div className="space-y-2">
                  {fields.map((field, index) => (
                    <div
                      key={field.id}
                      className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] p-3 grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center"
                    >
                      <div className="sm:col-span-4">
                        <input
                          type="text"
                          aria-label={`Field ${index + 1} name`}
                          value={field.name}
                          onChange={(e) => updateField(field.id, { name: e.target.value })}
                          placeholder="FieldName"
                          className="w-full rounded-md border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] px-2.5 py-1.5 text-xs font-mono text-[#1B2340] dark:text-white"
                        />
                      </div>

                      <div className="sm:col-span-4">
                        <select
                          aria-label={`Field ${index + 1} type`}
                          value={field.friendlyType}
                          onChange={(e) =>
                            updateField(field.id, { friendlyType: e.target.value as FriendlyFieldType })
                          }
                          className="w-full rounded-md border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] px-2.5 py-1.5 text-xs text-[#1B2340] dark:text-white"
                        >
                          {FRIENDLY_FIELD_TYPES.map((t) => (
                            <option key={t.friendlyType} value={t.friendlyType}>
                              {mode === 'simple' ? `${t.label} (${t.tsqlType})` : `${t.tsqlType} · ${t.label}`}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="sm:col-span-2 flex items-center gap-3 text-xs">
                        <label className="inline-flex items-center gap-1 cursor-pointer" title="Required (NOT NULL)">
                          <input
                            type="checkbox"
                            checked={!field.nullable}
                            onChange={(e) => updateField(field.id, { nullable: !e.target.checked })}
                          />
                          <span>Req</span>
                        </label>
                        <label className="inline-flex items-center gap-1 cursor-pointer" title="Primary Key">
                          <input
                            type="checkbox"
                            checked={field.isPrimaryKey}
                            onChange={(e) =>
                              updateField(field.id, {
                                isPrimaryKey: e.target.checked,
                                nullable: e.target.checked ? false : field.nullable,
                              })
                            }
                          />
                          <span>PK</span>
                        </label>
                      </div>

                      <div className="sm:col-span-2 flex items-center justify-end gap-1">
                        <button
                          type="button"
                          aria-label={`Move ${field.name} up`}
                          onClick={() => moveField(index, -1)}
                          className="p-1 text-slate-400 hover:text-[#1B2340] dark:hover:text-white"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${field.name} down`}
                          onClick={() => moveField(index, 1)}
                          className="p-1 text-slate-400 hover:text-[#1B2340] dark:hover:text-white"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${field.name}`}
                          disabled={fields.length <= 1}
                          onClick={() => setFields((prev) => prev.filter((f) => f.id !== field.id))}
                          className="p-1 text-slate-400 hover:text-[#E5484D] disabled:opacity-30"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="alter-tbl" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Target Table
                  </label>
                  <select
                    id="alter-tbl"
                    value={alterTargetTable?.fullName ?? ''}
                    onChange={(e) => {
                      setAlterTableKey(e.target.value);
                      setSelectedConstraintCols([]);
                    }}
                    className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-xs font-mono text-[#1B2340] dark:text-white"
                  >
                    {(snapshot?.tables ?? []).map((t) => (
                      <option key={t.fullName} value={t.fullName}>
                        {t.fullName}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="alter-op" className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    DDL Operation
                  </label>
                  <select
                    id="alter-op"
                    value={alterKind}
                    onChange={(e) => setAlterKind(e.target.value as AlterOperationKind)}
                    className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-xs text-[#1B2340] dark:text-white"
                  >
                    <option value="ADD_COLUMN">Add Column</option>
                    <option value="ALTER_COLUMN">Modify Column Properties (SQL Server)</option>
                    <option value="DROP_COLUMN">Remove Column (Destructive)</option>
                    <option value="ADD_PRIMARY_KEY">Add Primary Key Constraint (SQL Server)</option>
                    <option value="ADD_UNIQUE_CONSTRAINT">Add Unique Constraint</option>
                    <option value="DROP_CONSTRAINT">Drop Constraint (SQL Server)</option>
                    <option value="CREATE_INDEX">Create Index (Clustered/Nonclustered)</option>
                    <option value="DROP_INDEX">Drop Index</option>
                  </select>
                </div>
              </div>

              {alterKind === 'ADD_COLUMN' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 rounded-lg bg-[#F7F8FC] dark:bg-[#181F38] border border-[#E2E6F0] dark:border-[#232B45]">
                  <div>
                    <label htmlFor="add-col-name" className="block text-xs font-medium mb-1">
                      New Field Name
                    </label>
                    <input
                      id="add-col-name"
                      type="text"
                      placeholder="e.g. Notes"
                      value={newCol.name}
                      onChange={(e) => setNewCol((c) => ({ ...c, name: e.target.value }))}
                      className="w-full rounded-md border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] px-3 py-1.5 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label htmlFor="add-col-type" className="block text-xs font-medium mb-1">
                      Field Type
                    </label>
                    <select
                      id="add-col-type"
                      value={newCol.friendlyType}
                      onChange={(e) =>
                        setNewCol((c) => ({ ...c, friendlyType: e.target.value as FriendlyFieldType }))
                      }
                      className="w-full rounded-md border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] px-3 py-1.5 text-xs"
                    >
                      {FRIENDLY_FIELD_TYPES.filter((t) => t.friendlyType !== 'auto_id').map((t) => (
                        <option key={t.friendlyType} value={t.friendlyType}>
                          {t.label} ({t.tsqlType})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="add-col-def" className="block text-xs font-medium mb-1">
                      Default Value (Optional)
                    </label>
                    <input
                      id="add-col-def"
                      type="text"
                      placeholder="Required if non-nullable on populated table"
                      value={newCol.defaultValue ?? ''}
                      onChange={(e) => setNewCol((c) => ({ ...c, defaultValue: e.target.value }))}
                      className="w-full rounded-md border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] px-3 py-1.5 text-xs"
                    />
                  </div>
                  <div className="flex items-end pb-1">
                    <label className="inline-flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={!newCol.nullable}
                        onChange={(e) => setNewCol((c) => ({ ...c, nullable: !e.target.checked }))}
                      />
                      <span>Required (NOT NULL)</span>
                    </label>
                  </div>
                </div>
              )}

              {alterKind === 'ALTER_COLUMN' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 rounded-lg bg-[#F7F8FC] dark:bg-[#181F38] border border-[#E2E6F0] dark:border-[#232B45]">
                  <div>
                    <label className="block text-xs font-medium mb-1">Existing Column</label>
                    <select
                      value={alterColName}
                      onChange={(e) => setAlterColName(e.target.value)}
                      className="w-full rounded-md border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] px-3 py-1.5 text-xs font-mono"
                    >
                      {(alterTargetTable?.columns ?? []).map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name} ({c.sqlType})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">New Target Type</label>
                    <select
                      value={alterColType}
                      onChange={(e) => setAlterColType(e.target.value as FriendlyFieldType)}
                      className="w-full rounded-md border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] px-3 py-1.5 text-xs"
                    >
                      {FRIENDLY_FIELD_TYPES.filter((t) => t.friendlyType !== 'auto_id').map((t) => (
                        <option key={t.friendlyType} value={t.friendlyType}>
                          {t.label} ({t.tsqlType})
                        </option>
                      ))}
                    </select>
                  </div>
                  {alterColType === 'text' && (
                    <div>
                      <label className="block text-xs font-medium mb-1">Max Length</label>
                      <input
                        type="number"
                        min={1}
                        max={4000}
                        value={alterColLength}
                        onChange={(e) => setAlterColLength(Number(e.target.value))}
                        className="w-full rounded-md border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] px-3 py-1.5 text-xs font-mono"
                      />
                    </div>
                  )}
                  <div className="flex items-end pb-1">
                    <label className="inline-flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={!alterColNullable}
                        onChange={(e) => setAlterColNullable(!e.target.checked)}
                      />
                      <span>Required (NOT NULL)</span>
                    </label>
                  </div>
                </div>
              )}

              {alterKind === 'DROP_COLUMN' && (
                <div className="p-4 rounded-lg bg-red-50/70 dark:bg-red-950/20 border border-red-200 dark:border-red-900 space-y-2">
                  <label htmlFor="drop-col-select" className="block text-xs font-medium text-[#E5484D]">
                    Select Column to Permanently Remove
                  </label>
                  <select
                    id="drop-col-select"
                    value={dropColName}
                    onChange={(e) => setDropColName(e.target.value)}
                    className="w-full rounded-md border border-red-200 dark:border-red-900 bg-white dark:bg-[#12172B] px-3 py-2 text-xs font-mono"
                  >
                    <option value="">Choose column...</option>
                    {(alterTargetTable?.columns ?? []).map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name} ({c.sqlType})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {(alterKind === 'ADD_PRIMARY_KEY' ||
                alterKind === 'ADD_UNIQUE_CONSTRAINT' ||
                alterKind === 'CREATE_INDEX') && (
                <div className="space-y-3 p-4 rounded-lg bg-[#F7F8FC] dark:bg-[#181F38] border border-[#E2E6F0] dark:border-[#232B45]">
                  <div>
                    <label className="block text-xs font-medium mb-1">
                      {alterKind === 'CREATE_INDEX' ? 'Index Name (Optional)' : 'Constraint Name (Optional)'}
                    </label>
                    <input
                      type="text"
                      value={constraintName}
                      onChange={(e) => setConstraintName(e.target.value)}
                      placeholder={alterKind === 'CREATE_INDEX' ? 'IX_Table_Column' : 'UQ_Table_Column'}
                      className="w-full rounded-md border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] px-3 py-1.5 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <div className="text-xs font-medium mb-1.5">Included Columns</div>
                    <div className="flex flex-wrap gap-2">
                      {(alterTargetTable?.columns ?? []).map((c) => {
                        const checked = selectedConstraintCols.includes(c.name);
                        return (
                          <label
                            key={c.name}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs cursor-pointer ${
                              checked
                                ? 'border-[#6D4AFF] bg-[#6D4AFF]/10 text-[#6D4AFF]'
                                : 'border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B]'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                if (e.target.checked) setSelectedConstraintCols((p) => [...p, c.name]);
                                else setSelectedConstraintCols((p) => p.filter((x) => x !== c.name));
                              }}
                            />
                            <span className="font-mono">{c.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  {alterKind === 'CREATE_INDEX' && (
                    <label className="inline-flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={uniqueIndexFlag}
                        onChange={(e) => setUniqueIndexFlag(e.target.checked)}
                      />
                      <span>Create UNIQUE Index</span>
                    </label>
                  )}
                </div>
              )}

              {(alterKind === 'DROP_CONSTRAINT' || alterKind === 'DROP_INDEX') && (
                <div className="p-4 rounded-lg bg-[#F7F8FC] dark:bg-[#181F38] border border-[#E2E6F0] dark:border-[#232B45] space-y-2">
                  <label className="block text-xs font-medium">
                    {alterKind === 'DROP_INDEX' ? 'Index Name to Drop' : 'Constraint Name to Drop'}
                  </label>
                  <input
                    type="text"
                    value={constraintName}
                    onChange={(e) => setConstraintName(e.target.value)}
                    placeholder={
                      alterKind === 'DROP_INDEX'
                        ? alterTargetTable?.indexes[0]?.name || 'IX_Name'
                        : 'PK_... or UQ_...'
                    }
                    className="w-full rounded-md border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] px-3 py-1.5 text-xs font-mono"
                  />
                </div>
              )}
            </div>
          )}
        </section>

        <aside className="xl:col-span-5 rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-[#1B2340] dark:text-white">
              Impact & Generated T-SQL Preview
            </h2>
            <span className="text-xs text-slate-500">Target: {connection.method === 'local_sandbox' ? 'SQLite Sandbox' : 'SQL Server T-SQL'}</span>
          </div>

          {!previewResult.ok ? (
            <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3 text-xs text-[#E5484D]">
              {previewResult.error}
            </div>
          ) : (
            <>
              <div className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                {previewResult.compiled.plainExplanation}
              </div>

              <div className="space-y-1.5">
                {previewResult.compiled.preflight.checks.map((chk) => (
                  <div key={chk.name} className="flex items-start gap-2 text-xs">
                    {chk.status === 'pass' ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-[#16A66A] shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                    )}
                    <div>
                      <span className="font-medium text-[#1B2340] dark:text-white">{chk.name}: </span>
                      <span className="text-slate-500 dark:text-slate-400">{chk.detail}</span>
                    </div>
                  </div>
                ))}
                {previewResult.compiled.preflight.warnings.map((w, i) => (
                  <div key={i} className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-2.5 text-xs text-amber-800 dark:text-amber-300">
                    {w}
                  </div>
                ))}
              </div>

              <div className="rounded-lg bg-[#13172B] text-slate-100 p-3.5 overflow-x-auto">
                <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap">
                  {previewResult.compiled.tsql}
                </pre>
              </div>

              <div className="pt-2 flex items-center justify-between gap-3">
                <span className="text-[11px] text-slate-500">
                  Target: <span className="font-mono">{connection.database}</span>
                </span>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={handleStagePlan}
                  className="px-4 py-2 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-xs font-medium disabled:opacity-50 whitespace-nowrap"
                >
                  {submitting ? 'Staging Change Plan...' : 'Stage Change Plan for Review'}
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
