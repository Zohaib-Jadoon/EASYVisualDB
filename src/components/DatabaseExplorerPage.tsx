import React, { useEffect, useMemo, useState } from 'react';
import {
  Database,
  Edit3,
  FolderKanban,
  Key,
  Link2,
  Plus,
  RefreshCw,
  Search,
  Table2,
  Trash2,
} from 'lucide-react';
import { api } from '../lib/api';
import { FRIENDLY_FIELD_TYPES } from '../shared/sqlCompiler';
import {
  AppMode,
  ConnectionProfile,
  DatabaseInfo,
  SchemaSnapshot,
  TableDependency,
  TableSchema,
} from '../shared/types';
import { NavSection } from './AppShell';

interface DatabaseExplorerPageProps {
  mode: AppMode;
  connection: ConnectionProfile | null;
  snapshot: SchemaSnapshot | null;
  selectedTableKey: string | null;
  onSelectTableKey: (key: string) => void;
  onRefreshSchema: () => Promise<void>;
  onRefreshAll: () => Promise<void>;
  onNavigate: (nav: NavSection) => void;
  onStageDropTable: (table: TableSchema) => Promise<void>;
  onToast: (tone: 'success' | 'error' | 'info', title: string, detail?: string) => void;
}

export function DatabaseExplorerPage({
  mode,
  connection,
  snapshot,
  selectedTableKey,
  onSelectTableKey,
  onRefreshSchema,
  onRefreshAll,
  onNavigate,
  onStageDropTable,
  onToast,
}: DatabaseExplorerPageProps) {
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // Server databases & creation
  const [databasesModalOpen, setDatabasesModalOpen] = useState(false);
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [newDbName, setNewDbName] = useState('');
  const [newDbCollation, setNewDbCollation] = useState('');
  const [creatingDb, setCreatingDb] = useState(false);

  // Table dependencies
  const [dependencies, setDependencies] = useState<TableDependency[]>([]);
  const [loadingDeps, setLoadingDeps] = useState(false);

  // Safe Rename Modal
  const [renameModal, setRenameModal] = useState<{
    table: TableSchema;
    columnName?: string;
    newName: string;
  } | null>(null);
  const [renaming, setRenaming] = useState(false);

  const filteredTables = useMemo(() => {
    const tables = snapshot?.tables ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter(
      (t) =>
        t.fullName.toLowerCase().includes(q) ||
        t.columns.some((c) => c.name.toLowerCase().includes(q))
    );
  }, [snapshot, search]);

  const activeTable =
    filteredTables.find((t) => t.fullName === selectedTableKey) ??
    snapshot?.tables.find((t) => t.fullName === selectedTableKey) ??
    filteredTables[0] ??
    null;

  useEffect(() => {
    if (!connection || !activeTable) {
      setDependencies([]);
      return;
    }
    setLoadingDeps(true);
    api
      .getTableDependencies(connection.id, activeTable.schemaName, activeTable.tableName)
      .then((res) => setDependencies(res.dependencies || []))
      .catch(() => setDependencies([]))
      .finally(() => setLoadingDeps(false));
  }, [connection?.id, activeTable?.fullName]);

  const loadDatabasesList = async () => {
    if (!connection) return;
    setLoadingDbs(true);
    try {
      const res = await api.listDatabases(connection.id);
      setDatabases(res.databases || []);
    } catch (err) {
      onToast('error', 'Could not list server databases', err instanceof Error ? err.message : 'Error');
    } finally {
      setLoadingDbs(false);
    }
  };

  const handleOpenDatabases = async () => {
    setDatabasesModalOpen(true);
    await loadDatabasesList();
  };

  const handleCreateDatabase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connection || !newDbName.trim()) return;
    setCreatingDb(true);
    try {
      const res = await api.createDatabase(
        connection.id,
        newDbName.trim(),
        newDbCollation.trim() || undefined
      );
      setNewDbName('');
      setNewDbCollation('');
      onToast('success', 'Database operation complete', res.message);
      await loadDatabasesList();
    } catch (err) {
      onToast('error', 'Create database failed', err instanceof Error ? err.message : 'Permission denied');
    } finally {
      setCreatingDb(false);
    }
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connection || !renameModal || !renameModal.newName.trim()) return;
    setRenaming(true);
    try {
      const res = await api.renameObject(connection.id, {
        schemaName: renameModal.table.schemaName,
        tableName: renameModal.table.tableName,
        columnName: renameModal.columnName,
        newName: renameModal.newName.trim(),
      });
      onToast('success', 'Object renamed', res.message);
      setRenameModal(null);
      await onRefreshAll();
    } catch (err) {
      onToast('error', 'Rename failed', err instanceof Error ? err.message : 'Error');
    } finally {
      setRenaming(false);
    }
  };

  const handleStageDropIndex = async (tbl: TableSchema, indexName: string) => {
    if (!connection) return;
    try {
      await api.createPlan(connection.id, `Drop index ${indexName} on ${tbl.fullName}`, [
        { kind: 'DROP_INDEX', indexName, schemaName: tbl.schemaName, tableName: tbl.tableName },
      ]);
      await onRefreshAll();
      onToast('info', 'Drop index staged', 'Review and execute in Change Center.');
      onNavigate('changes');
    } catch (err) {
      onToast('error', 'Unable to stage index drop', err instanceof Error ? err.message : 'Error');
    }
  };

  if (!connection || !snapshot) {
    return (
      <div className="max-w-3xl mx-auto rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-8 text-center space-y-3">
        <Database className="h-8 w-8 mx-auto text-[#6D4AFF]" />
        <h2 className="font-display text-lg font-semibold text-[#1B2340] dark:text-white">
          No database metadata loaded
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Connect a SQL Server instance or load the interactive sample database from Overview or Connections.
        </p>
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

  const getFriendlyLabel = (ft: string) =>
    FRIENDLY_FIELD_TYPES.find((m) => m.friendlyType === ft)?.label ?? ft;

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[#1B2340] dark:text-white">
            {mode === 'simple' ? 'Database Explorer' : 'Catalog Object Explorer'}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {snapshot.databaseName} · Snapshot {new Date(snapshot.capturedAt).toLocaleString()}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleOpenDatabases}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] text-xs font-medium text-[#1B2340] dark:text-white hover:bg-slate-50 dark:hover:bg-[#181F38]"
          >
            <FolderKanban className="h-3.5 w-3.5 text-[#6D4AFF]" />
            <span>Databases & Properties</span>
          </button>
          <button
            type="button"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              try {
                await onRefreshSchema();
              } finally {
                setRefreshing(false);
              }
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] text-xs font-medium text-[#1B2340] dark:text-white hover:bg-slate-50 dark:hover:bg-[#181F38]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>Refresh Metadata</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('table-builder')}
            className="px-3.5 py-2 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-xs font-medium"
          >
            New Table
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <aside className="lg:col-span-4 rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] flex flex-col max-h-[700px]">
          <div className="p-3 border-b border-[#E2E6F0] dark:border-[#232B45]">
            <div className="relative">
              <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                aria-label="Filter tables and columns"
                placeholder="Search tables or fields..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] pl-8 pr-3 py-1.5 text-xs text-[#1B2340] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#6D4AFF]"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {filteredTables.map((tbl) => {
              const selected = activeTable?.fullName === tbl.fullName;
              return (
                <button
                  key={tbl.fullName}
                  type="button"
                  onClick={() => onSelectTableKey(tbl.fullName)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-left transition-colors ${
                    selected
                      ? 'bg-[#6D4AFF]/10 text-[#6D4AFF] dark:text-[#A692FF] font-medium'
                      : 'text-[#1B2340] dark:text-slate-200 hover:bg-[#F7F8FC] dark:hover:bg-[#181F38]'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Table2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate text-xs font-mono">
                      {mode === 'simple' ? tbl.tableName : tbl.fullName}
                    </span>
                  </div>
                  <span className="text-[11px] tabular-nums text-slate-400 shrink-0">
                    {tbl.rowCountEstimate} rows
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="lg:col-span-8 rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-5">
          {!activeTable ? (
            <div className="py-12 text-center text-xs text-slate-500">Select a table to inspect its structure.</div>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-4 border-b border-[#E2E6F0] dark:border-[#232B45]">
                <div>
                  <h2 className="font-display text-lg font-bold text-[#1B2340] dark:text-white font-mono">
                    {mode === 'developer' ? `[${activeTable.schemaName}].[${activeTable.tableName}]` : activeTable.tableName}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
                    {activeTable.objectType} · {activeTable.columns.length} fields · ~{activeTable.rowCountEstimate} records ·{' '}
                    {activeTable.hasStablePrimaryKey
                      ? `Primary key: ${activeTable.primaryKeyColumns.join(', ')}`
                      : 'No Primary Key (read-only editing)'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setRenameModal({
                        table: activeTable,
                        newName: activeTable.tableName,
                      })
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs font-medium hover:bg-slate-50 dark:hover:bg-[#181F38]"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                    <span>Rename Table</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectTableKey(activeTable.fullName);
                      onNavigate('records');
                    }}
                    className="px-3 py-1.5 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-xs font-medium"
                  >
                    Browse Records
                  </button>
                  <button
                    type="button"
                    onClick={() => onStageDropTable(activeTable)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs text-[#E5484D] hover:bg-red-50 dark:hover:bg-red-950/30"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Stage Drop</span>
                  </button>
                </div>
              </div>

              {/* Columns Table */}
              <div>
                <h3 className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">
                  {mode === 'simple' ? 'Fields' : 'Columns'}
                </h3>
                <div className="overflow-x-auto border border-[#E2E6F0] dark:border-[#232B45] rounded-lg">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#F7F8FC] dark:bg-[#181F38] border-b border-[#E2E6F0] dark:border-[#232B45] text-slate-500 dark:text-slate-400">
                      <tr>
                        <th className="py-2 px-3 font-medium">Name</th>
                        <th className="py-2 px-3 font-medium">
                          {mode === 'simple' ? 'Field Type' : 'SQL Server Type'}
                        </th>
                        <th className="py-2 px-3 font-medium">Required</th>
                        <th className="py-2 px-3 font-medium">Constraints</th>
                        <th className="py-2 px-3 font-medium text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E2E6F0] dark:divide-[#232B45]">
                      {activeTable.columns.map((col) => (
                        <tr key={col.name} className="hover:bg-[#F7F8FC] dark:hover:bg-[#181F38]/50">
                          <td className="py-2 px-3 font-mono font-medium text-[#1B2340] dark:text-white flex items-center gap-1.5">
                            {col.isPrimaryKey && <Key className="h-3 w-3 text-amber-500 shrink-0" />}
                            <span>{col.name}</span>
                          </td>
                          <td className="py-2 px-3" title={col.sqlType}>
                            {mode === 'simple' ? (
                              <span>
                                {getFriendlyLabel(col.friendlyType)}{' '}
                                <span className="font-mono text-[11px] text-slate-400">({col.sqlType})</span>
                              </span>
                            ) : (
                              <span className="font-mono">{col.sqlType}</span>
                            )}
                          </td>
                          <td className="py-2 px-3">{col.nullable ? 'Optional (NULL)' : 'Required'}</td>
                          <td className="py-2 px-3 text-slate-500 dark:text-slate-400">
                            {[
                              col.isPrimaryKey ? 'Primary Key' : null,
                              col.isIdentity ? 'Auto ID' : null,
                              col.isUnique && !col.isPrimaryKey ? 'Unique' : null,
                              col.defaultValue ? `Default: ${col.defaultValue}` : null,
                            ]
                              .filter(Boolean)
                              .join(' · ') || '—'}
                          </td>
                          <td className="py-2 px-3 text-right">
                            <button
                              type="button"
                              onClick={() =>
                                setRenameModal({
                                  table: activeTable,
                                  columnName: col.name,
                                  newName: col.name,
                                })
                              }
                              className="text-[11px] text-[#6D4AFF] hover:underline"
                            >
                              Rename
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Foreign Keys & Indexes */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] p-3.5 space-y-2">
                  <div className="text-xs font-semibold text-[#1B2340] dark:text-white flex items-center gap-1.5">
                    <Link2 className="h-3.5 w-3.5 text-[#6D4AFF]" />
                    <span>Relationships ({activeTable.foreignKeys.length})</span>
                  </div>
                  {activeTable.foreignKeys.length === 0 ? (
                    <p className="text-xs text-slate-500">No outgoing foreign keys.</p>
                  ) : (
                    <ul className="space-y-1.5 text-xs">
                      {activeTable.foreignKeys.map((fk) => (
                        <li key={fk.name} className="font-mono text-slate-600 dark:text-slate-300">
                          {fk.sourceColumn} → {fk.targetSchema}.{fk.targetTable}.{fk.targetColumn}{' '}
                          <span className="text-slate-400">(DEL: {fk.onDelete})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] p-3.5 space-y-2">
                  <div className="text-xs font-semibold text-[#1B2340] dark:text-white flex items-center justify-between">
                    <span>Indexes ({activeTable.indexes.length})</span>
                    <button
                      type="button"
                      onClick={() => onNavigate('table-builder')}
                      className="text-[11px] font-medium text-[#6D4AFF] hover:underline"
                    >
                      + Create Index
                    </button>
                  </div>
                  {activeTable.indexes.length === 0 ? (
                    <p className="text-xs text-slate-500">No nonclustered indexes defined.</p>
                  ) : (
                    <ul className="space-y-1.5 text-xs">
                      {activeTable.indexes.map((idx) => (
                        <li key={idx.name} className="flex items-center justify-between gap-2 font-mono text-slate-600 dark:text-slate-300">
                          <span className="truncate">
                            {idx.name} ({idx.columns.join(', ')}) {idx.isUnique ? '· UNIQUE' : ''}
                          </span>
                          {!idx.isPrimaryKey && (
                            <button
                              type="button"
                              onClick={() => handleStageDropIndex(activeTable, idx.name)}
                              className="text-[11px] text-[#E5484D] hover:underline shrink-0"
                            >
                              Drop
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {/* Live Dependencies Inspector */}
              <div className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] p-3.5 space-y-2">
                <div className="text-xs font-semibold text-[#1B2340] dark:text-white">
                  Object Dependencies ({dependencies.length})
                </div>
                {loadingDeps ? (
                  <p className="text-xs text-slate-400">Checking foreign key and view references...</p>
                ) : dependencies.length === 0 ? (
                  <p className="text-xs text-slate-500">No incoming or outgoing table/view dependencies detected.</p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {dependencies.map((d, i) => (
                      <li key={i} className="flex flex-wrap items-center gap-2 text-slate-600 dark:text-slate-300">
                        <span className="font-mono text-[11px] font-semibold text-[#6D4AFF] uppercase">
                          {d.direction}
                        </span>
                        <span className="font-mono">{d.objectName}</span>
                        <span className="text-slate-400">— {d.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {/* Databases & Properties Modal */}
      {databasesModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Server Databases and Properties"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/55"
        >
          <div className="w-full max-w-4xl rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4 max-h-[88vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-[#E2E6F0] dark:border-[#232B45]">
              <div>
                <h2 className="font-display text-base font-bold text-[#1B2340] dark:text-white">
                  Server Databases & Properties — {connection.name}
                </h2>
                <p className="text-xs text-slate-500">
                  Inspect recovery models, collation, disk size, and execute guarded CREATE DATABASE operations.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDatabasesModalOpen(false)}
                className="px-3 py-1 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs"
              >
                Close
              </button>
            </div>

            {connection.method !== 'local_sandbox' && (
              <form
                onSubmit={handleCreateDatabase}
                className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 p-3.5 rounded-lg bg-[#F7F8FC] dark:bg-[#181F38] border border-[#E2E6F0] dark:border-[#232B45]"
              >
                <input
                  type="text"
                  required
                  placeholder="New SQL Server database name"
                  value={newDbName}
                  onChange={(e) => setNewDbName(e.target.value)}
                  className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] px-3 py-1.5 text-xs font-mono"
                />
                <input
                  type="text"
                  placeholder="Collation (optional, e.g. SQL_Latin1_General_CP1_CI_AS)"
                  value={newDbCollation}
                  onChange={(e) => setNewDbCollation(e.target.value)}
                  className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] px-3 py-1.5 text-xs font-mono"
                />
                <button
                  type="submit"
                  disabled={creatingDb}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>{creatingDb ? 'Creating...' : 'Create Database'}</span>
                </button>
              </form>
            )}

            <div className="overflow-x-auto border border-[#E2E6F0] dark:border-[#232B45] rounded-lg">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#F7F8FC] dark:bg-[#181F38] border-b border-[#E2E6F0] dark:border-[#232B45] text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Database</th>
                    <th className="px-3 py-2 font-medium">State</th>
                    <th className="px-3 py-2 font-medium">Recovery</th>
                    <th className="px-3 py-2 font-medium">Collation</th>
                    <th className="px-3 py-2 font-medium text-right">Size (MB)</th>
                    <th className="px-3 py-2 font-medium">Access</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E6F0] dark:divide-[#232B45]">
                  {loadingDbs ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                        Inspecting server database catalog...
                      </td>
                    </tr>
                  ) : databases.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                        No database metadata returned.
                      </td>
                    </tr>
                  ) : (
                    databases.map((db) => (
                      <tr key={db.name} className="hover:bg-[#F7F8FC] dark:hover:bg-[#181F38]/50">
                        <td className="px-3 py-2 font-mono font-medium text-[#1B2340] dark:text-white">
                          {db.name}
                          {db.isSystem ? ' (system)' : ''}
                        </td>
                        <td className="px-3 py-2">{db.stateDesc}</td>
                        <td className="px-3 py-2">{db.recoveryModel}</td>
                        <td className="px-3 py-2 font-mono text-[11px]">{db.collationName}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{db.sizeMb.toFixed(2)}</td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            onClick={async () => {
                              await api.updateConnection(connection.id, { database: db.name });
                              setDatabasesModalOpen(false);
                              await onRefreshAll();
                              onToast('info', `Switched database context to ${db.name}`);
                            }}
                            disabled={db.name === connection.database || connection.method === 'local_sandbox'}
                            className="text-[#6D4AFF] hover:underline disabled:opacity-40"
                          >
                            {db.name === connection.database ? 'Active' : 'Switch'}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Safe Object Rename Modal */}
      {renameModal && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/55">
          <form
            onSubmit={handleRenameSubmit}
            className="w-full max-w-md rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4"
          >
            <h2 className="font-display text-base font-bold text-[#1B2340] dark:text-white">
              Rename {renameModal.columnName ? 'Column' : 'Table'}
            </h2>
            <p className="text-xs text-slate-500">
              Current identifier:{' '}
              <span className="font-mono">
                {renameModal.table.fullName}
                {renameModal.columnName ? `.${renameModal.columnName}` : ''}
              </span>
            </p>
            <input
              type="text"
              required
              autoFocus
              value={renameModal.newName}
              onChange={(e) => setRenameModal({ ...renameModal, newName: e.target.value })}
              className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-xs font-mono"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenameModal(null)}
                className="px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={renaming}
                className="px-4 py-1.5 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium disabled:opacity-50"
              >
                {renaming ? 'Renaming...' : 'Execute Rename'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
