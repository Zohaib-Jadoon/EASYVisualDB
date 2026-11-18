import React, { useEffect, useMemo, useState } from 'react';
import {
  Download,
  HelpCircle,
  Link2,
  Play,
  Plus,
  Save,
  Trash2,
  Wand2,
} from 'lucide-react';
import { api } from '../lib/api';
import { compileVisualQuery } from '../shared/sqlCompiler';
import {
  ConnectionProfile,
  QueryExecutionResult,
  SchemaSnapshot,
  SqlErrorExplanation,
  VisualQueryAggregate,
  VisualQueryFilter,
  VisualQueryJoin,
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
  const firstTable = snapshot?.tables[0] ?? null;
  const [tableKey, setTableKey] = useState(firstTable?.fullName ?? '');
  const selectedTable =
    snapshot?.tables.find((t) => t.fullName === tableKey) ?? firstTable;

  const [selectedCols, setSelectedCols] = useState<string[]>([]);
  const [joins, setJoins] = useState<VisualQueryJoin[]>([]);
  const [filters, setFilters] = useState<VisualQueryFilter[]>([]);
  const [groupByCols, setGroupByCols] = useState<string[]>([]);
  const [aggregates, setAggregates] = useState<VisualQueryAggregate[]>([]);
  const [orderCol, setOrderCol] = useState<string>('');
  const [orderDir, setOrderDir] = useState<'ASC' | 'DESC'>('ASC');
  const [limit, setLimit] = useState(50);

  // SQL Editor & Resource limits state
  const [sqlText, setSqlText] = useState(
    initialSql ||
      (firstTable
        ? `SELECT TOP (50) *\nFROM [${firstTable.schemaName}].[${firstTable.tableName}];`
        : 'SELECT 1 AS HealthCheck;')
  );
  const [timeoutMs, setTimeoutMs] = useState(15000);
  const [maxRows, setMaxRows] = useState(200);
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
  const [errorExplanation, setErrorExplanation] = useState<SqlErrorExplanation | null>(null);

  useEffect(() => {
    if (selectedTable) {
      setSelectedCols(selectedTable.columns.map((c) => c.name));
      setOrderCol(selectedTable.columns[0]?.name ?? '');
      setJoins([]);
      setGroupByCols([]);
      setAggregates([]);
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

  const visualSpec = useMemo(() => {
    if (!selectedTable) return null;
    return {
      schemaName: selectedTable.schemaName,
      tableName: selectedTable.tableName,
      columns: selectedCols,
      joins,
      filters,
      groupBy: groupByCols,
      aggregates,
      orderBy: orderCol ? { column: orderCol, direction: orderDir } : null,
      limit,
    };
  }, [selectedTable, selectedCols, joins, filters, groupByCols, aggregates, orderCol, orderDir, limit]);

  const compiledVisualPreview = useMemo(() => {
    if (!visualSpec || (visualSpec.columns.length === 0 && (visualSpec.aggregates?.length ?? 0) === 0)) {
      return '';
    }
    try {
      const dialect = connection?.method === 'local_sandbox' ? 'sqlite' : 'tsql';
      return compileVisualQuery(visualSpec, dialect).sql;
    } catch {
      return '';
    }
  }, [visualSpec, connection?.method]);

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

  const handleCaptureError = async (err: unknown) => {
    const eObj = err as Error & { payload?: { explanation?: SqlErrorExplanation } };
    const msg = eObj.message || 'SQL execution failed.';
    setErrorMsg(msg);
    if (eObj.payload?.explanation) {
      setErrorExplanation(eObj.payload.explanation);
    } else {
      try {
        const res = await api.explainSqlError(msg);
        setErrorExplanation(res.explanation);
      } catch {
        setErrorExplanation(null);
      }
    }
  };

  const handleRunVisual = async () => {
    if (!visualSpec) return;
    setRunning(true);
    setErrorMsg(null);
    setErrorExplanation(null);
    try {
      const res = await api.runVisualQuery(connection.id, visualSpec);
      setResult(res.result);
      await loadQueryMeta();
    } catch (err) {
      await handleCaptureError(err);
    } finally {
      setRunning(false);
    }
  };

  const handleRunSql = async () => {
    setRunning(true);
    setErrorMsg(null);
    setErrorExplanation(null);
    try {
      const res = await api.runSqlQuery(connection.id, sqlText, { timeoutMs, maxRows });
      setResult(res.result);
      await loadQueryMeta();
    } catch (err) {
      await handleCaptureError(err);
    } finally {
      setRunning(false);
    }
  };

  const handleFormatSql = async () => {
    try {
      const res = await api.formatSql(sqlText);
      setSqlText(res.formatted);
    } catch (err) {
      onToast('error', 'Format failed', err instanceof Error ? err.message : 'Error');
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
            {activeView === 'query-builder' ? 'Visual Query Builder' : 'SQL Editor'}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {activeView === 'query-builder'
              ? 'Join tables, filter rows, compute aggregates, and run parameterized queries.'
              : 'Execute schema-aware SQL statements with formatting, resource caps, and error explanations.'}
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
                <label className="block text-xs font-medium mb-1">Primary Table</label>
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
                    <option value="">None</option>
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

            {/* Table Joins */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium flex items-center gap-1.5">
                  <Link2 className="h-3.5 w-3.5 text-[#6D4AFF]" />
                  <span>Joins ({joins.length})</span>
                </span>
                {snapshot.tables.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      const other = snapshot.tables.find((t) => t.fullName !== selectedTable.fullName) ?? selectedTable;
                      setJoins((p) => [
                        ...p,
                        {
                          id: `jn_${Date.now()}`,
                          joinType: 'INNER',
                          targetSchema: other.schemaName,
                          targetTable: other.tableName,
                          sourceColumn: selectedTable.columns[0]?.name ?? '',
                          targetColumn: other.columns[0]?.name ?? '',
                        },
                      ]);
                    }}
                    className="inline-flex items-center gap-1 text-xs font-medium text-[#6D4AFF]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Add Join</span>
                  </button>
                )}
              </div>
              {joins.map((jn) => {
                const joinedTbl = snapshot.tables.find(
                  (t) => t.schemaName === jn.targetSchema && t.tableName === jn.targetTable
                );
                return (
                  <div key={jn.id} className="grid grid-cols-12 gap-1.5 items-center text-xs">
                    <select
                      value={jn.joinType}
                      onChange={(e) =>
                        setJoins((p) => p.map((x) => (x.id === jn.id ? { ...x, joinType: e.target.value as 'INNER' | 'LEFT' } : x)))
                      }
                      className="col-span-2 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-1.5 py-1.5"
                    >
                      <option value="INNER">INNER</option>
                      <option value="LEFT">LEFT</option>
                    </select>
                    <select
                      value={`${jn.targetSchema}.${jn.targetTable}`}
                      onChange={(e) => {
                        const t = snapshot.tables.find((tb) => tb.fullName === e.target.value);
                        if (!t) return;
                        setJoins((p) =>
                          p.map((x) =>
                            x.id === jn.id
                              ? { ...x, targetSchema: t.schemaName, targetTable: t.tableName, targetColumn: t.columns[0]?.name ?? '' }
                              : x
                          )
                        );
                      }}
                      className="col-span-3 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-1.5 py-1.5 font-mono"
                    >
                      {snapshot.tables.map((t) => (
                        <option key={t.fullName} value={t.fullName}>
                          {t.tableName}
                        </option>
                      ))}
                    </select>
                    <select
                      value={jn.sourceColumn}
                      onChange={(e) =>
                        setJoins((p) => p.map((x) => (x.id === jn.id ? { ...x, sourceColumn: e.target.value } : x)))
                      }
                      className="col-span-3 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-1.5 py-1.5 font-mono"
                    >
                      {selectedTable.columns.map((c) => (
                        <option key={c.name} value={c.name}>
                          {selectedTable.tableName}.{c.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={jn.targetColumn}
                      onChange={(e) =>
                        setJoins((p) => p.map((x) => (x.id === jn.id ? { ...x, targetColumn: e.target.value } : x)))
                      }
                      className="col-span-3 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-1.5 py-1.5 font-mono"
                    >
                      {(joinedTbl?.columns ?? []).map((c) => (
                        <option key={c.name} value={c.name}>
                          {jn.targetTable}.{c.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label="Remove join"
                      onClick={() => setJoins((p) => p.filter((x) => x.id !== jn.id))}
                      className="col-span-1 p-1 text-slate-400 hover:text-[#E5484D]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Aggregates & GROUP BY */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">Aggregations ({aggregates.length})</span>
                <button
                  type="button"
                  onClick={() =>
                    setAggregates((p) => [
                      ...p,
                      {
                        func: 'COUNT',
                        column: selectedTable.columns[0]?.name ?? '*',
                        alias: `Count_${selectedTable.columns[0]?.name ?? 'Rows'}`,
                      },
                    ])
                  }
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#6D4AFF]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Aggregate</span>
                </button>
              </div>
              {aggregates.map((ag, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center text-xs">
                  <select
                    value={ag.func}
                    onChange={(e) =>
                      setAggregates((p) =>
                        p.map((x, i) => (i === idx ? { ...x, func: e.target.value as VisualQueryAggregate['func'] } : x))
                      )
                    }
                    className="col-span-3 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2 py-1.5 font-mono"
                  >
                    {(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'] as const).map((fn) => (
                      <option key={fn} value={fn}>
                        {fn}
                      </option>
                    ))}
                  </select>
                  <select
                    value={ag.column}
                    onChange={(e) =>
                      setAggregates((p) => p.map((x, i) => (i === idx ? { ...x, column: e.target.value } : x)))
                    }
                    className="col-span-4 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2 py-1.5 font-mono"
                  >
                    {selectedTable.columns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={ag.alias}
                    onChange={(e) =>
                      setAggregates((p) => p.map((x, i) => (i === idx ? { ...x, alias: e.target.value } : x)))
                    }
                    placeholder="Alias"
                    className="col-span-4 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2 py-1.5 font-mono"
                  />
                  <button
                    type="button"
                    aria-label="Remove aggregate"
                    onClick={() => setAggregates((p) => p.filter((_, i) => i !== idx))}
                    className="col-span-1 p-1 text-slate-400 hover:text-[#E5484D]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {aggregates.length > 0 && selectedCols.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                  <span>GROUP BY:</span>
                  {selectedCols.map((col) => {
                    const active = groupByCols.includes(col);
                    return (
                      <button
                        key={col}
                        type="button"
                        onClick={() =>
                          setGroupByCols((p) => (active ? p.filter((x) => x !== col) : [...p, col]))
                        }
                        className={`px-2 py-0.5 rounded border font-mono ${
                          active ? 'border-[#6D4AFF] bg-[#6D4AFF]/10 text-[#6D4AFF]' : 'border-[#E2E6F0] dark:border-[#232B45]'
                        }`}
                      >
                        {col}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Filters */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">Filters ({filters.length})</span>
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
                disabled={running || (selectedCols.length === 0 && aggregates.length === 0)}
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
              Parameterized SQL Preview ({connection.method === 'local_sandbox' ? 'SQLite' : 'T-SQL'})
            </h2>
            <div className="rounded-lg bg-[#13172B] text-slate-100 p-3.5">
              <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed">
                {compiledVisualPreview || 'Select columns or aggregates to generate SQL.'}
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
          <aside className="lg:col-span-3 rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-3.5 space-y-3 max-h-[380px] overflow-y-auto">
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

          <section className="lg:col-span-9 rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-1.5 text-slate-500">
                  <span>Timeout (ms):</span>
                  <input
                    type="number"
                    min={1000}
                    max={60000}
                    step={1000}
                    value={timeoutMs}
                    onChange={(e) => setTimeoutMs(Number(e.target.value))}
                    className="w-20 rounded border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2 py-1 font-mono tabular-nums"
                  />
                </label>
                <label className="inline-flex items-center gap-1.5 text-slate-500">
                  <span>Max Rows:</span>
                  <input
                    type="number"
                    min={10}
                    max={1000}
                    step={50}
                    value={maxRows}
                    onChange={(e) => setMaxRows(Number(e.target.value))}
                    className="w-20 rounded border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2 py-1 font-mono tabular-nums"
                  />
                </label>
              </div>
              <button
                type="button"
                onClick={handleFormatSql}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[#E2E6F0] dark:border-[#232B45] text-xs font-medium hover:bg-slate-50 dark:hover:bg-[#181F38]"
              >
                <Wand2 className="h-3.5 w-3.5 text-[#6D4AFF]" />
                <span>Format SQL</span>
              </button>
            </div>

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

      {/* SQL Error & Plain-Language Explanation */}
      {errorMsg && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 space-y-2 text-xs">
          <div className="font-semibold text-[#E5484D]">{errorMsg}</div>
          {errorExplanation && (
            <div className="rounded-lg bg-white/80 dark:bg-[#12172B] border border-red-200 dark:border-red-900/60 p-3 space-y-1 text-slate-700 dark:text-slate-200">
              <div className="font-semibold flex items-center gap-1.5">
                <HelpCircle className="h-3.5 w-3.5 text-[#6D4AFF]" />
                <span>
                  {errorExplanation.title}
                  {errorExplanation.code ? ` (SQL Error ${errorExplanation.code})` : ''}
                </span>
              </div>
              <p>{errorExplanation.summary}</p>
              <p className="text-slate-500 dark:text-slate-400">
                <strong>Suggested Fix:</strong> {errorExplanation.suggestion}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Results Table */}
      {result && (
        <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#E2E6F0] dark:border-[#232B45] flex items-center justify-between text-xs">
            <div className="tabular-nums text-slate-600 dark:text-slate-300">
              {result.rowCount} row(s) returned in {result.durationMs}ms
              {result.truncated ? ` (capped at ${maxRows} rows)` : ''}
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

      {history.length > 0 && (
        <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-4 space-y-2">
          <h3 className="font-display text-xs font-semibold text-slate-500">Recent Query History</h3>
          <div className="divide-y divide-[#E2E6F0] dark:divide-[#232B45]">
            {history.slice(0, 6).map((h) => (
              <div key={h.id} className="py-2 flex items-center justify-between gap-4 text-xs">
                <button
                  type="button"
                  onClick={() => setSqlText(h.sql_text)}
                  className="font-mono text-[11px] truncate text-left text-slate-700 dark:text-slate-300 hover:text-[#6D4AFF]"
                >
                  {h.sql_text}
                </button>
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
