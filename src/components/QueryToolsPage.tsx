import React, { useEffect, useMemo, useState } from 'react';
import { Download, Play, Plus, Save, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { compileVisualQuery } from '../shared/sqlCompiler';
import {
  ConnectionProfile,
  QueryExecutionResult,
  SchemaSnapshot,
  VisualQueryFilter,
} from '../shared/types';
import { NavSection } from './AppShell';

interface QueryToolsPageProps {
  activeView: 'query-builder' | 'sql-editor';
  connection: ConnectionProfile | null;
  snapshot: SchemaSnapshot | null;
  initialSql?: string;
  onNavigate: (nav: NavSection) => void;
  onToast: (tone: 'success' | 'error' | 'info', title: string, detail?: string) => void;
}

export function QueryToolsPage({
  activeView,
  connection,
  snapshot,
  initialSql,
  onNavigate,
  onToast,
}: QueryToolsPageProps) {
  // Visual Query Builder State
  const firstTable = snapshot?.tables[0] ?? null;
  const [tableKey, setTableKey] = useState(firstTable?.fullName ?? '');
  const selectedTable =
    snapshot?.tables.find((t) => t.fullName === tableKey) ?? firstTable;

  const [selectedCols, setSelectedCols] = useState<string[]>([]);
  const [filters, setFilters] = useState<VisualQueryFilter[]>([]);
  const [orderCol, setOrderCol] = useState<string>('');
  const [orderDir, setOrderDir] = useState<'ASC' | 'DESC'>('ASC');
  const [limit, setLimit] = useState(50);

  // SQL Editor State
  const [sqlText, setSqlText] = useState(
    initialSql ||
      (firstTable
        ? `SELECT TOP (50) *\nFROM [${firstTable.schemaName}].[${firstTable.tableName}];`
        : 'SELECT 1 AS HealthCheck;')
  );
  const [saveName, setSaveName] = useState('');
  const [savedQueries, setSavedQueries] = useState<
    Array<{ id: string; name: string; sql_text: string; created_by: string; created_at: string }>
  >([]);
  const [history, setHistory] = useState<
    Array<{ id: string; sql_text: string; row_count: number; duration_ms: number; status: string }>
  >([]);

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryExecutionResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (selectedTable) {
      setSelectedCols(selectedTable.columns.map((c) => c.name));
      setOrderCol(selectedTable.columns[0]?.name ?? '');
    }
  }, [selectedTable?.fullName]);

  useEffect(() => {
    if (initialSql) setSqlText(initialSql);
  }, [initialSql]);

  const loadQueryMeta = async () => {
    if (!connection) return;
    try {
      const res = await api.listQueries(connection.id);
      setSavedQueries(res.saved);
      setHistory(res.history);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadQueryMeta();
  }, [connection?.id]);

  const compiledVisualPreview = useMemo(() => {
    if (!selectedTable || selectedCols.length === 0) return '';
    try {
      return compileVisualQuery(
        {
          schemaName: selectedTable.schemaName,
          tableName: selectedTable.tableName,
          columns: selectedCols,
          filters,
          orderBy: orderCol ? { column: orderCol, direction: orderDir } : null,
          limit,
        },
        'tsql'
      ).sql;
    } catch {
      return '';
    }
  }, [selectedTable, selectedCols, filters, orderCol, orderDir, limit]);

  if (!connection || !snapshot) {
    return (
      <div className="max-w-3xl mx-auto rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-8 text-center space-y-3">
        <h2 className="font-display text-lg font-semibold text-[#1B2340] dark:text-white">
          Connect a database to run queries
        </h2>
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

  const handleRunVisual = async () => {
    if (!selectedTable || selectedCols.length === 0) return;
    setRunning(true);
    setErrorMsg(null);
    try {
      const res = await api.runVisualQuery(connection.id, {
        schemaName: selectedTable.schemaName,
        tableName: selectedTable.tableName,
        columns: selectedCols,
        filters,
        orderBy: orderCol ? { column: orderCol, direction: orderDir } : null,
        limit,
      });
      setResult(res.result);
      await loadQueryMeta();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Query failed.');
    } finally {
      setRunning(false);
    }
  };

  const handleRunSql = async () => {
    setRunning(true);
    setErrorMsg(null);
    try {
      const res = await api.runSqlQuery(connection.id, sqlText);
      setResult(res.result);
      await loadQueryMeta();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'SQL execution failed.');
    } finally {
      setRunning(false);
    }
  };

  const handleSaveCurrentQuery = async () => {
    const targetSql = activeView === 'query-builder' ? compiledVisualPreview : sqlText;
    if (!saveName.trim() || !targetSql) return;
    try {
      await api.saveQuery(connection.id, saveName.trim(), targetSql);
      setSaveName('');
      await loadQueryMeta();
      onToast('success', 'Query saved', 'Added to workspace saved queries.');
    } catch (err) {
      onToast('error', 'Save failed', err instanceof Error ? err.message : 'Error');
    }
  };

  const handleExportResults = () => {
    if (!result || result.rows.length === 0) return;
    const csv = [
      result.columns.join(','),
      ...result.rows.map((r) =>
        result.columns.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(',')
      ),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `query-results.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#1B2340] dark:text-white">
            {activeView === 'query-builder' ? 'No-Code Visual Query Builder' : 'SQL Editor'}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {activeView === 'query-builder'
              ? 'Filter, sort, and export records with parameterized read-only queries.'
              : 'Execute schema-aware SQL statements bounded by your connection access level.'}
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg bg-[#F1F3F9] dark:bg-[#181F38] border border-[#E2E6F0] dark:border-[#232B45]">
          <button
            type="button"
            onClick={() => onNavigate('query-builder')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${
              activeView === 'query-builder'
                ? 'bg-white dark:bg-[#12172B] text-[#6D4AFF] shadow-xs'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            Visual Builder
          </button>
          <button
            type="button"
            onClick={() => onNavigate('sql-editor')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${
              activeView === 'sql-editor'
                ? 'bg-white dark:bg-[#12172B] text-[#6D4AFF] shadow-xs'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            SQL Editor
          </button>
        </div>
      </div>

      {activeView === 'query-builder' && selectedTable ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <section className="lg:col-span-7 rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Table</label>
                <select
                  value={selectedTable.fullName}
                  onChange={(e) => setTableKey(e.target.value)}
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-xs font-mono"
                >
                  {snapshot.tables.map((t) => (
                    <option key={t.fullName} value={t.fullName}>
                      {t.fullName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium mb-1">Sort By</label>
                  <select
                    value={orderCol}
                    onChange={(e) => setOrderCol(e.target.value)}
                    className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2.5 py-2 text-xs font-mono"
                  >
                    {selectedTable.columns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Order & Limit</label>
                  <div className="flex gap-1">
                    <select
                      value={orderDir}
                      onChange={(e) => setOrderDir(e.target.value as 'ASC' | 'DESC')}
                      className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2 py-2 text-xs"
                    >
                      <option value="ASC">ASC</option>
                      <option value="DESC">DESC</option>
                    </select>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={limit}
                      onChange={(e) => setLimit(Number(e.target.value))}
                      className="w-16 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2 py-2 text-xs tabular-nums"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Columns picker */}
            <div>
              <div className="text-xs font-medium mb-1.5">Fields to Include</div>
              <div className="flex flex-wrap gap-2">
                {selectedTable.columns.map((col) => {
                  const checked = selectedCols.includes(col.name);
                  return (
                    <label
                      key={col.name}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs cursor-pointer ${
                        checked
                          ? 'border-[#6D4AFF] bg-[#6D4AFF]/10 text-[#6D4AFF] dark:text-[#A692FF]'
                          : 'border-[#E2E6F0] dark:border-[#232B45] text-slate-500'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedCols((p) => [...p, col.name]);
                          else setSelectedCols((p) => p.filter((x) => x !== col.name));
                        }}
                      />
                      <span className="font-mono">{col.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Filters */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">Filters</span>
                <button
                  type="button"
                  onClick={() =>
                    setFilters((prev) => [
                      ...prev,
                      {
                        id: `flt_${Date.now()}`,
                        column: selectedTable.columns[0]?.name ?? '',
                        operator: 'eq',
                        value: '',
                      },
                    ])
                  }
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#6D4AFF]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add filter</span>
                </button>
              </div>
              {filters.map((flt) => (
                <div key={flt.id} className="grid grid-cols-12 gap-2 items-center">
                  <select
                    value={flt.column}
                    onChange={(e) =>
                      setFilters((p) => p.map((x) => (x.id === flt.id ? { ...x, column: e.target.value } : x)))
                    }
                    className="col-span-4 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2 py-1.5 text-xs font-mono"
                  >
                    {selectedTable.columns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={flt.operator}
                    onChange={(e) =>
                      setFilters((p) =>
                        p.map((x) =>
                          x.id === flt.id ? { ...x, operator: e.target.value as VisualQueryFilter['operator'] } : x
                        )
                      )
                    }
                    className="col-span-3 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2 py-1.5 text-xs"
                  >
                    <option value="eq">equals</option>
                    <option value="neq">not equals</option>
                    <option value="contains">contains</option>
                    <option value="gt">&gt;</option>
                    <option value="lt">&lt;</option>
                    <option value="is_null">is empty</option>
                    <option value="is_not_null">is not empty</option>
                  </select>
                  <input
                    type="text"
                    disabled={flt.operator === 'is_null' || flt.operator === 'is_not_null'}
                    value={flt.value}
                    onChange={(e) =>
                      setFilters((p) => p.map((x) => (x.id === flt.id ? { ...x, value: e.target.value } : x)))
                    }
                    placeholder="Value"
                    className="col-span-4 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2.5 py-1.5 text-xs"
                  />
                  <button
                    type="button"
                    aria-label="Remove filter"
                    onClick={() => setFilters((p) => p.filter((x) => x.id !== flt.id))}
                    className="col-span-1 p-1 text-slate-400 hover:text-[#E5484D]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <div className="pt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={running || selectedCols.length === 0}
                onClick={handleRunVisual}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-xs font-medium disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                <span>{running ? 'Running...' : 'Run Read-Only Query'}</span>
              </button>
            </div>
          </section>

          <aside className="lg:col-span-5 rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-3">
            <h2 className="font-display text-sm font-semibold text-[#1B2340] dark:text-white">
              Parameterized SQL Preview
            </h2>
            <div className="rounded-lg bg-[#13172B] text-slate-100 p-3.5">
              <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed">
                {compiledVisualPreview || 'Select columns to generate SQL.'}
              </pre>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Save query as..."
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                className="flex-1 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-1.5 text-xs"
              />
              <button
                type="button"
                onClick={handleSaveCurrentQuery}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs font-medium"
              >
                <Save className="h-3.5 w-3.5" />
                <span>Save</span>
              </button>
            </div>
          </aside>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Schema Sidebar */}
          <aside className="lg:col-span-3 rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-3.5 space-y-3 max-h-[360px] overflow-y-auto">
            <div className="text-xs font-semibold text-[#1B2340] dark:text-white">
              Schema Quick Insert
            </div>
            <div className="space-y-1.5">
              {snapshot.tables.map((t) => (
                <button
                  key={t.fullName}
                  type="button"
                  onClick={() =>
                    setSqlText(`SELECT TOP (50) ${t.columns.map((c) => `[${c.name}]`).join(', ')}\nFROM [${t.schemaName}].[${t.tableName}];`)
                  }
                  className="w-full text-left px-2.5 py-1.5 rounded-md text-xs font-mono text-slate-700 dark:text-slate-300 hover:bg-[#F1F3F9] dark:hover:bg-[#181F38] truncate"
                >
                  {t.fullName}
                </button>
              ))}
            </div>
            {savedQueries.length > 0 && (
              <div className="pt-2 border-t border-[#E2E6F0] dark:border-[#232B45]">
                <div className="text-[11px] font-medium text-slate-400 mb-1">Saved Scripts</div>
                {savedQueries.map((sq) => (
                  <button
                    key={sq.id}
                    type="button"
                    onClick={() => setSqlText(sq.sql_text)}
                    className="w-full text-left px-2 py-1 rounded text-xs text-[#6D4AFF] hover:underline truncate"
                  >
                    {sq.name}
                  </button>
                ))}
              </div>
            )}
          </aside>

          {/* SQL Text Editor */}
          <section className="lg:col-span-9 rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-4 space-y-3">
            <textarea
              aria-label="SQL Editor"
              rows={9}
              value={sqlText}
              onChange={(e) => setSqlText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleRunSql();
                }
              }}
              className="w-full rounded-lg bg-[#13172B] text-slate-100 font-mono text-xs p-4 leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Script name..."
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-1.5 text-xs"
                />
                <button
                  type="button"
                  onClick={handleSaveCurrentQuery}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs font-medium"
                >
                  <Save className="h-3.5 w-3.5" />
                  <span>Save Script</span>
                </button>
              </div>
              <button
                type="button"
                disabled={running}
                onClick={handleRunSql}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-xs font-medium disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                <span>{running ? 'Executing...' : 'Run Query (⌘Enter)'}</span>
              </button>
            </div>
          </section>
        </div>
      )}

      {/* Error Message */}
      {errorMsg && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-xs text-[#E5484D]">
          {errorMsg}
        </div>
      )}

      {/* Results Table */}
      {result && (
        <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#E2E6F0] dark:border-[#232B45] flex items-center justify-between text-xs">
            <div className="tabular-nums text-slate-600 dark:text-slate-300">
              {result.rowCount} row(s) returned in {result.durationMs}ms
              {result.truncated ? ' (capped at 200 rows)' : ''}
            </div>
            <button
              type="button"
              onClick={handleExportResults}
              className="inline-flex items-center gap-1 text-[#6D4AFF] font-medium hover:underline"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export Results CSV</span>
            </button>
          </div>
          <div className="overflow-x-auto max-h-96">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-[#F7F8FC] dark:bg-[#181F38] border-b border-[#E2E6F0] dark:border-[#232B45] sticky top-0">
                <tr>
                  {result.columns.map((c) => (
                    <th key={c} className="px-3 py-2 font-mono font-medium text-slate-600 dark:text-slate-300">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E6F0] dark:divide-[#232B45]">
                {result.rows.map((row, idx) => (
                  <tr key={idx} className="hover:bg-[#F7F8FC] dark:hover:bg-[#181F38]/50">
                    {result.columns.map((c) => (
                      <td key={c} className="px-3 py-1.5 font-mono truncate max-w-[260px]">
                        {row[c] === null || row[c] === undefined ? 'NULL' : String(row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Recent Query History */}
      {history.length > 0 && (
        <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-4 space-y-2">
          <h3 className="font-display text-xs font-semibold text-slate-500">Recent Query History</h3>
          <div className="divide-y divide-[#E2E6F0] dark:divide-[#232B45]">
            {history.slice(0, 5).map((h) => (
              <div key={h.id} className="py-2 flex items-center justify-between gap-4 text-xs">
                <code className="font-mono text-[11px] truncate text-slate-700 dark:text-slate-300">
                  {h.sql_text}
                </code>
                <span className="tabular-nums text-slate-400 shrink-0">
                  {h.status} · {h.row_count} rows · {h.duration_ms}ms
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
