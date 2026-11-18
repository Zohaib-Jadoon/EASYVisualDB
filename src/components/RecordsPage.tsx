import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownUp,
  ChevronLeft,
  ChevronRight,
  Download,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { api } from '../lib/api';
import { canModifyData } from '../shared/permissions';
import {
  AppMode,
  ConnectionProfile,
  SchemaSnapshot,
  WorkspaceMember,
} from '../shared/types';
import { NavSection } from './AppShell';

interface RecordsPageProps {
  mode: AppMode;
  connection: ConnectionProfile | null;
  snapshot: SchemaSnapshot | null;
  actor: WorkspaceMember | null;
  selectedTableKey: string | null;
  onSelectTableKey: (key: string) => void;
  onNavigate: (nav: NavSection) => void;
  onToast: (tone: 'success' | 'error' | 'info', title: string, detail?: string) => void;
}

export function RecordsPage({
  mode,
  connection,
  snapshot,
  actor,
  selectedTableKey,
  onSelectTableKey,
  onNavigate,
  onToast,
}: RecordsPageProps) {
  const activeTable = useMemo(() => {
    if (!snapshot || snapshot.tables.length === 0) return null;
    return (
      snapshot.tables.find((t) => t.fullName === selectedTableKey) ?? snapshot.tables[0]
    );
  }, [snapshot, selectedTableKey]);

  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const [sortColumn, setSortColumn] = useState<string | undefined>(undefined);
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('ASC');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  // Row selection & inline edit state
  const [selectedPks, setSelectedPks] = useState<Set<string | number>>(new Set());
  const [editingCell, setEditingCell] = useState<{
    rowIndex: number;
    column: string;
    value: string;
    originalRow: Record<string, unknown>;
  } | null>(null);

  // Modals
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newRowValues, setNewRowValues] = useState<Record<string, string>>({});
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [csvText, setCsvText] = useState('');

  const writeCheck = useMemo(() => {
    if (!actor || !connection) return { allowed: false, reason: 'No active connection.' };
    if (!activeTable?.hasStablePrimaryKey) {
      return {
        allowed: false,
        reason: 'This table has no stable Primary Key. Editing is disabled to prevent accidental multi-row updates.',
      };
    }
    return canModifyData(actor, connection);
  }, [actor, connection, activeTable]);

  const loadRows = useCallback(async () => {
    if (!connection || !activeTable) return;
    setLoading(true);
    try {
      const res = await api.browseRecords(connection.id, {
        schema: activeTable.schemaName,
        table: activeTable.tableName,
        page,
        pageSize,
        sortColumn,
        sortDir,
        search: search.trim() || undefined,
      });
      setRows(res.rows);
      setTotalRows(res.totalRows);
      setSelectedPks(new Set());
    } catch (err) {
      onToast('error', 'Failed to load records', err instanceof Error ? err.message : 'Query error');
    } finally {
      setLoading(false);
    }
  }, [connection, activeTable, page, sortColumn, sortDir, search, onToast]);

  useEffect(() => {
    setPage(1);
    setSortColumn(undefined);
    setEditingCell(null);
  }, [activeTable?.fullName]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  const pkCol = activeTable?.primaryKeyColumns[0];

  const handleSaveInlineEdit = async () => {
    if (!connection || !activeTable || !editingCell || !pkCol) return;
    const pkVal = editingCell.originalRow[pkCol];
    try {
      await api.updateRecord(connection.id, {
        schemaName: activeTable.schemaName,
        tableName: activeTable.tableName,
        pkValues: { [pkCol]: pkVal },
        updates: { [editingCell.column]: editingCell.value === '' ? null : editingCell.value },
        originalValues: { [editingCell.column]: editingCell.originalRow[editingCell.column] },
      });
      setEditingCell(null);
      await loadRows();
      onToast('success', 'Record updated', `Saved ${editingCell.column} on ${activeTable.tableName}.`);
    } catch (err) {
      onToast('error', 'Update rejected', err instanceof Error ? err.message : 'Conflict or validation error');
    }
  };

  const handleAddRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connection || !activeTable) return;
    const payload: Record<string, unknown> = {};
    for (const col of activeTable.columns) {
      if (col.isIdentity) continue;
      const raw = newRowValues[col.name];
      if (raw === undefined || raw === '') {
        if (!col.nullable && !col.defaultValue) {
          onToast('error', 'Required field missing', `Please provide a value for ${col.name}.`);
          return;
        }
        continue;
      }
      if (col.friendlyType === 'integer') payload[col.name] = Number.parseInt(raw, 10);
      else if (col.friendlyType === 'decimal' || col.friendlyType === 'money') payload[col.name] = Number.parseFloat(raw);
      else if (col.friendlyType === 'boolean') payload[col.name] = raw === 'true' || raw === '1' ? 1 : 0;
      else payload[col.name] = raw;
    }

    try {
      await api.insertRecord(connection.id, activeTable.schemaName, activeTable.tableName, payload);
      setAddModalOpen(false);
      setNewRowValues({});
      await loadRows();
      onToast('success', 'Record inserted', `Added 1 row to ${activeTable.tableName}.`);
    } catch (err) {
      onToast('error', 'Insert failed', err instanceof Error ? err.message : 'Validation error');
    }
  };

  const handleConfirmDelete = async () => {
    if (!connection || !activeTable || !pkCol || selectedPks.size === 0) return;
    try {
      const res = await api.deleteRecords(connection.id, {
        schemaName: activeTable.schemaName,
        tableName: activeTable.tableName,
        pkColumn: pkCol,
        pkValues: Array.from(selectedPks),
      });
      setDeleteModalOpen(false);
      await loadRows();
      onToast('success', 'Records deleted', `Removed ${res.deletedCount} record(s).`);
    } catch (err) {
      onToast('error', 'Delete failed', err instanceof Error ? err.message : 'Error');
    }
  };

  const handleExportCsv = () => {
    if (!activeTable || rows.length === 0) return;
    const cols = activeTable.columns.map((c) => c.name);
    const escape = (v: unknown) => {
      const str = v === null || v === undefined ? '' : String(v);
      return `"${str.replace(/"/g, '""')}"`;
    };
    const csv = [
      cols.join(','),
      ...rows.map((r) => cols.map((c) => escape(r[c])).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTable.tableName}-page-${page}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const parsedCsvPreview = useMemo(() => {
    const lines = csvText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) return null;
    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    const parsedRows = lines.slice(1).map((line) => {
      const vals = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
      const obj: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        obj[h] = vals[i] ?? '';
      });
      return obj;
    });
    return { headers, rows: parsedRows };
  }, [csvText]);

  const handleCommitCsvImport = async () => {
    if (!connection || !activeTable || !parsedCsvPreview) return;
    try {
      const res = await api.importCsv(connection.id, {
        schemaName: activeTable.schemaName,
        tableName: activeTable.tableName,
        rows: parsedCsvPreview.rows,
      });
      setImportModalOpen(false);
      setCsvText('');
      await loadRows();
      onToast(
        res.committed > 0 ? 'success' : 'error',
        `CSV import complete`,
        `${res.committed} committed, ${res.skipped} skipped.`
      );
    } catch (err) {
      onToast('error', 'CSV import failed', err instanceof Error ? err.message : 'Error');
    }
  };

  const colCount = activeTable ? activeTable.columns.length + (pkCol ? 1 : 0) : 1;

  if (!connection || !snapshot || !activeTable) {
    return (
      <div className="max-w-3xl mx-auto rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-8 text-center space-y-3">
        <h2 className="font-display text-lg font-semibold text-[#1B2340] dark:text-white">
          No tables available to browse
        </h2>
        <p className="text-xs text-slate-500">Connect a SQL Server or load the sample database first.</p>
        <button
          type="button"
          onClick={() => onNavigate('connections')}
          className="px-4 py-2 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium"
        >
          Open Connections
        </button>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      {/* Header & Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-2xl font-bold text-[#1B2340] dark:text-white">
            Records
          </h1>
          <select
            aria-label="Select table to browse"
            value={activeTable.fullName}
            onChange={(e) => onSelectTableKey(e.target.value)}
            className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] px-3 py-1.5 text-xs font-mono text-[#1B2340] dark:text-white"
          >
            {snapshot.tables.map((t) => (
              <option key={t.fullName} value={t.fullName}>
                {mode === 'simple' ? t.tableName : t.fullName}
              </option>
            ))}
          </select>
          <span className="text-xs text-slate-500 tabular-nums">
            {totalRows} total row(s)
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              aria-label="Search records"
              placeholder="Search visible table..."
              value={search}
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
              className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] pl-8 pr-3 py-1.5 text-xs text-[#1B2340] dark:text-white"
            />
          </div>

          <button
            type="button"
            onClick={loadRows}
            aria-label="Refresh records"
            className="p-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] hover:bg-slate-50 dark:hover:bg-[#181F38]"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          <button
            type="button"
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] text-xs font-medium hover:bg-slate-50 dark:hover:bg-[#181F38]"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export CSV</span>
          </button>

          <button
            type="button"
            disabled={!writeCheck.allowed}
            onClick={() => setImportModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] text-xs font-medium hover:bg-slate-50 dark:hover:bg-[#181F38] disabled:opacity-40"
          >
            <Upload className="h-3.5 w-3.5" />
            <span>Import CSV</span>
          </button>

          {selectedPks.size > 0 && writeCheck.allowed && (
            <button
              type="button"
              onClick={() => setDeleteModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#E5484D] text-white text-xs font-medium"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Delete ({selectedPks.size})</span>
            </button>
          )}

          <button
            type="button"
            disabled={!writeCheck.allowed}
            onClick={() => setAddModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-xs font-medium disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Record</span>
          </button>
        </div>
      </div>

      {/* Read-only explanation banner when applicable */}
      {!writeCheck.allowed && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-4 py-2.5 flex items-center justify-between gap-3 text-xs text-amber-800 dark:text-amber-300">
          <div className="flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 shrink-0" />
            <span>{writeCheck.reason}</span>
          </div>
          {connection.readOnly && (
            <button
              type="button"
              onClick={() => onNavigate('connections')}
              className="font-medium underline shrink-0"
            >
              Manage Connection Mode
            </button>
          )}
        </div>
      )}

      {/* Spreadsheet Grid */}
      <div className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-[#F7F8FC] dark:bg-[#181F38] border-b border-[#E2E6F0] dark:border-[#232B45]">
              <tr>
                {pkCol && (
                  <th className="px-3 py-2.5 w-10 border-r border-[#E2E6F0] dark:border-[#232B45]">
                    <input
                      type="checkbox"
                      aria-label="Select all visible rows"
                      checked={
                        rows.length > 0 &&
                        rows.every((r) => selectedPks.has(r[pkCol] as string | number))
                      }
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedPks(new Set(rows.map((r) => r[pkCol] as string | number)));
                        } else {
                          setSelectedPks(new Set());
                        }
                      }}
                    />
                  </th>
                )}
                {activeTable.columns.map((colSchema) => (
                  <th
                    key={colSchema.name}
                    className="px-3 py-2.5 text-xs font-medium text-slate-600 dark:text-slate-300 border-r last:border-r-0 border-[#E2E6F0] dark:border-[#232B45]"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (sortColumn === colSchema.name) {
                          setSortDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'));
                        } else {
                          setSortColumn(colSchema.name);
                          setSortDir('ASC');
                        }
                      }}
                      className="inline-flex items-center gap-1 font-medium text-xs hover:text-[#6D4AFF] whitespace-nowrap"
                    >
                      <span>{colSchema.name}</span>
                      <ArrowDownUp className="h-3 w-3 opacity-60" />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E6F0] dark:divide-[#232B45]">
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="px-4 py-10 text-center text-xs text-slate-500">
                    Loading records...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="px-4 py-10 text-center text-xs text-slate-500">
                    No matching records found in {activeTable.tableName}.
                  </td>
                </tr>
              ) : (
                rows.map((row, rowIndex) => {
                  const pkVal = pkCol ? (row[pkCol] as string | number) : rowIndex;
                  return (
                    <tr
                      key={String(pkVal)}
                      className="h-9 hover:bg-[#F7F8FC] dark:hover:bg-[#181F38]/60 transition-colors"
                    >
                      {pkCol && (
                        <td className="px-3 py-1.5 border-r border-[#E2E6F0] dark:border-[#232B45]">
                          <input
                            type="checkbox"
                            aria-label={`Select row ${pkVal}`}
                            checked={selectedPks.has(pkVal)}
                            onChange={(e) => {
                              setSelectedPks((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(pkVal);
                                else next.delete(pkVal);
                                return next;
                              });
                            }}
                          />
                        </td>
                      )}
                      {activeTable.columns.map((colSchema) => {
                        const val = row[colSchema.name];
                        const isEditing =
                          editingCell?.rowIndex === rowIndex &&
                          editingCell?.column === colSchema.name;
                        return (
                          <td
                            key={colSchema.name}
                            className="px-3 py-1.5 border-r last:border-r-0 border-[#E2E6F0] dark:border-[#232B45]"
                          >
                            {isEditing ? (
                              <div className="flex items-center gap-1">
                                <input
                                  autoFocus
                                  type="text"
                                  value={editingCell.value}
                                  onChange={(e) =>
                                    setEditingCell((prev) =>
                                      prev ? { ...prev, value: e.target.value } : null
                                    )
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveInlineEdit();
                                    if (e.key === 'Escape') setEditingCell(null);
                                  }}
                                  className="w-full min-w-[110px] rounded border border-[#6D4AFF] bg-white dark:bg-[#12172B] px-1.5 py-0.5 text-xs"
                                />
                                <button
                                  type="button"
                                  onClick={handleSaveInlineEdit}
                                  className="px-1.5 py-0.5 rounded bg-[#16A66A] text-white text-[10px] font-medium"
                                >
                                  Save
                                </button>
                              </div>
                            ) : (
                              <div
                                onDoubleClick={() => {
                                  if (
                                    !writeCheck.allowed ||
                                    colSchema.isIdentity ||
                                    colSchema.isPrimaryKey
                                  ) {
                                    return;
                                  }
                                  setEditingCell({
                                    rowIndex,
                                    column: colSchema.name,
                                    value: val === null || val === undefined ? '' : String(val),
                                    originalRow: row,
                                  });
                                }}
                                title={
                                  writeCheck.allowed && !colSchema.isIdentity
                                    ? 'Double-click cell to edit'
                                    : undefined
                                }
                                className={`truncate max-w-[240px] text-xs ${
                                  colSchema.friendlyType === 'integer' ||
                                  colSchema.friendlyType === 'decimal' ||
                                  colSchema.friendlyType === 'money' ||
                                  colSchema.friendlyType === 'auto_id'
                                    ? 'font-mono tabular-nums'
                                    : ''
                                } ${val === null || val === undefined ? 'text-slate-400 italic' : ''}`}
                              >
                                {val === null || val === undefined ? 'NULL' : String(val)}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <div className="px-4 py-2.5 border-t border-[#E2E6F0] dark:border-[#232B45] flex items-center justify-between text-xs text-slate-500">
          <div className="tabular-nums">
            Page {page} of {totalPages} · {pageSize} rows/page max
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              aria-label="Previous page"
              className="p-1.5 rounded border border-[#E2E6F0] dark:border-[#232B45] disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              aria-label="Next page"
              className="p-1.5 rounded border border-[#E2E6F0] dark:border-[#232B45] disabled:opacity-40"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Add Record Modal */}
      {addModalOpen && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/50">
          <form
            onSubmit={handleAddRecord}
            className="w-full max-w-lg rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4 max-h-[85vh] overflow-y-auto"
          >
            <h2 className="font-display text-base font-semibold text-[#1B2340] dark:text-white">
              Add Record to {activeTable.tableName}
            </h2>
            <div className="space-y-3">
              {activeTable.columns
                .filter((c) => !c.isIdentity)
                .map((col) => (
                  <div key={col.name}>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      {col.name}{' '}
                      <span className="text-slate-400 font-mono">
                        ({col.sqlType}) {!col.nullable && !col.defaultValue ? '*' : ''}
                      </span>
                    </label>
                    <input
                      type={col.friendlyType === 'date' ? 'date' : col.friendlyType === 'integer' || col.friendlyType === 'decimal' || col.friendlyType === 'money' ? 'number' : 'text'}
                      step={col.friendlyType === 'decimal' || col.friendlyType === 'money' ? 'any' : undefined}
                      required={!col.nullable && !col.defaultValue}
                      value={newRowValues[col.name] ?? ''}
                      onChange={(e) =>
                        setNewRowValues((prev) => ({ ...prev, [col.name]: e.target.value }))
                      }
                      placeholder={col.defaultValue ? `Default: ${col.defaultValue}` : ''}
                      className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-1.5 text-xs text-[#1B2340] dark:text-white"
                    />
                  </div>
                ))}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setAddModalOpen(false)}
                className="px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium"
              >
                Insert Record
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Controlled Delete Modal */}
      {deleteModalOpen && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/50">
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4">
            <h2 className="font-display text-base font-semibold text-[#E5484D]">
              Confirm Controlled Delete
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              You are about to permanently delete <strong className="tabular-nums">{selectedPks.size}</strong> record(s) from{' '}
              <span className="font-mono">{activeTable.fullName}</span> matching primary keys:{' '}
              <span className="font-mono">{Array.from(selectedPks).slice(0, 8).join(', ')}</span>.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteModalOpen(false)}
                className="px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="px-4 py-1.5 rounded-lg bg-[#E5484D] text-white text-xs font-medium"
              >
                Delete Records
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CSV Import Modal */}
      {importModalOpen && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/50">
          <div className="w-full max-w-xl rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4">
            <h2 className="font-display text-base font-semibold text-[#1B2340] dark:text-white">
              Import CSV into {activeTable.tableName}
            </h2>
            <p className="text-xs text-slate-500">
              Paste CSV data with column headers matching {activeTable.tableName} fields (excluding auto-ID columns).
            </p>
            <textarea
              rows={6}
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              placeholder={`Code,Name,Budget,IsActive\nMKT,Marketing,150000,1`}
              className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] p-3 text-xs font-mono"
            />
            {parsedCsvPreview && (
              <div className="text-xs text-slate-600 dark:text-slate-300 tabular-nums">
                Dry-run preview: {parsedCsvPreview.rows.length} row(s) detected across columns [{parsedCsvPreview.headers.join(', ')}].
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setImportModalOpen(false)}
                className="px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!parsedCsvPreview}
                onClick={handleCommitCsvImport}
                className="px-4 py-1.5 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium disabled:opacity-50"
              >
                Import Valid Rows
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
