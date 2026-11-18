import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Connection,
  Controls,
  Edge,
  Handle,
  MarkerType,
  MiniMap,
  Node,
  NodeProps,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import {
  Download,
  Key,
  LayoutGrid,
  Link2,
  Plus,
  Save,
  Search,
} from 'lucide-react';
import { api } from '../lib/api';
import { areColumnTypesCompatibleForFk } from '../shared/sqlCompiler';
import {
  AppMode,
  ConnectionProfile,
  DiagramNodePosition,
  SchemaSnapshot,
  TableSchema,
} from '../shared/types';
import { NavSection } from './AppShell';

interface VisualDesignerPageProps {
  mode: AppMode;
  connection: ConnectionProfile | null;
  snapshot: SchemaSnapshot | null;
  onPlanCreated: () => Promise<void>;
  onNavigate: (nav: NavSection) => void;
  onToast: (tone: 'success' | 'error' | 'info', title: string, detail?: string) => void;
}

interface TableNodeData extends Record<string, unknown> {
  table: TableSchema;
  mode: AppMode;
  highlighted: boolean;
  onOpenRecords: (tableKey: string) => void;
}

function TableNode({ data }: NodeProps<Node<TableNodeData>>) {
  const { table, mode, highlighted, onOpenRecords } = data;
  const fkCols = new Set(table.foreignKeys.map((fk) => fk.sourceColumn));

  return (
    <div
      className={`min-w-[245px] max-w-[295px] rounded-xl bg-white dark:bg-[#12172B] border shadow-sm ${
        highlighted
          ? 'border-[#6D4AFF] ring-2 ring-[#6D4AFF]/30'
          : 'border-[#E2E6F0] dark:border-[#232B45]'
      }`}
    >
      <div className="px-3 py-2 rounded-t-[11px] bg-[#13172B] text-white flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold truncate">
            {mode === 'developer' ? table.fullName : table.tableName}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onOpenRecords(table.fullName)}
          className="text-[10px] font-medium text-slate-300 hover:text-white shrink-0"
        >
          {table.rowCountEstimate} rows
        </button>
      </div>

      <div className="divide-y divide-[#E2E6F0] dark:divide-[#232B45] rounded-b-xl">
        {table.columns.map((col) => {
          const isFk = fkCols.has(col.name);
          return (
            <div
              key={col.name}
              className="relative px-3 py-1.5 flex items-center justify-between gap-2 text-[11px] hover:bg-[#F7F8FC] dark:hover:bg-[#181F38]"
            >
              <Handle
                type="target"
                position={Position.Left}
                id={`tgt:${col.name}`}
                className="!w-2 !h-2 !bg-[#6D4AFF] !border-white dark:!border-[#12172B]"
              />
              <div className="flex items-center gap-1.5 min-w-0">
                {col.isPrimaryKey ? (
                  <Key className="h-3 w-3 text-amber-500 shrink-0" />
                ) : isFk ? (
                  <Link2 className="h-3 w-3 text-[#6D4AFF] shrink-0" />
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <span className="font-mono font-medium text-[#1B2340] dark:text-slate-100 truncate">
                  {col.name}
                </span>
              </div>
              <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400 shrink-0">
                {mode === 'simple' ? col.friendlyType.replace('_', ' ') : col.sqlType.split(' ')[0]}
              </span>
              <Handle
                type="source"
                position={Position.Right}
                id={`src:${col.name}`}
                className="!w-2 !h-2 !bg-[#6D4AFF] !border-white dark:!border-[#12172B]"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const nodeTypes = { tableNode: TableNode };

export function VisualDesignerPage({
  mode,
  connection,
  snapshot,
  onPlanCreated,
  onNavigate,
  onToast,
}: VisualDesignerPageProps) {
  const [search, setSearch] = useState('');
  const [savedPositions, setSavedPositions] = useState<DiagramNodePosition[]>([]);
  const [savingLayout, setSavingLayout] = useState(false);

  // Relationship creation modal
  const [fkModalOpen, setFkModalOpen] = useState(false);
  const [sourceTableKey, setSourceTableKey] = useState('');
  const [sourceColumn, setSourceColumn] = useState('');
  const [targetTableKey, setTargetTableKey] = useState('');
  const [targetColumn, setTargetColumn] = useState('');
  const [onDelete, setOnDelete] = useState<'NO ACTION' | 'CASCADE' | 'SET NULL'>('NO ACTION');
  const [onUpdate, setOnUpdate] = useState<'NO ACTION' | 'CASCADE'>('NO ACTION');

  useEffect(() => {
    if (!connection) return;
    api
      .getDiagramLayout(connection.id)
      .then((res) => setSavedPositions(res.positions))
      .catch(() => setSavedPositions([]));
  }, [connection?.id]);

  const openRecordsForTable = useCallback(
    (_tableKey: string) => {
      onNavigate('records');
    },
    [onNavigate]
  );

  const initialNodes: Node<TableNodeData>[] = useMemo(() => {
    const tables = snapshot?.tables ?? [];
    const posMap = new Map(savedPositions.map((p) => [p.tableKey, p]));
    const q = search.trim().toLowerCase();

    return tables.map((tbl, idx) => {
      const saved = posMap.get(tbl.fullName);
      const col = idx % 3;
      const row = Math.floor(idx / 3);
      return {
        id: tbl.fullName,
        type: 'tableNode',
        position: saved ? { x: saved.x, y: saved.y } : { x: 40 + col * 410, y: 40 + row * 340 },
        data: {
          table: tbl,
          mode,
          highlighted: Boolean(q && tbl.fullName.toLowerCase().includes(q)),
          onOpenRecords: openRecordsForTable,
        },
      };
    });
  }, [snapshot, savedPositions, mode, search, openRecordsForTable]);

  const initialEdges: Edge[] = useMemo(() => {
    const tables = snapshot?.tables ?? [];
    const edges: Edge[] = [];
    for (const tbl of tables) {
      for (const fk of tbl.foreignKeys) {
        const targetKey = `${fk.targetSchema}.${fk.targetTable}`;
        edges.push({
          id: `${tbl.fullName}.${fk.sourceColumn}->${targetKey}.${fk.targetColumn}`,
          type: 'smoothstep',
          source: tbl.fullName,
          target: targetKey,
          sourceHandle: `src:${fk.sourceColumn}`,
          targetHandle: `tgt:${fk.targetColumn}`,
          label: `${fk.sourceColumn} → ${fk.targetColumn}`,
          animated: false,
          markerEnd: { type: MarkerType.ArrowClosed, color: '#6D4AFF' },
          style: { stroke: '#6D4AFF', strokeWidth: 1.75 },
          labelStyle: { fontSize: 10, fill: '#475569', fontWeight: 500 },
          labelBgStyle: { fill: '#F7F8FC', fillOpacity: 0.94 },
          labelBgPadding: [6, 3],
          labelBgBorderRadius: 4,
        });
      }
    }
    return edges;
  }, [snapshot]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  const handleConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      const sCol = conn.sourceHandle?.replace('src:', '') ?? '';
      const tCol = conn.targetHandle?.replace('tgt:', '') ?? '';
      setSourceTableKey(conn.source);
      setSourceColumn(sCol);
      setTargetTableKey(conn.target);
      setTargetColumn(tCol);
      setFkModalOpen(true);
    },
    []
  );

  const handleAutoLayout = () => {
    setNodes((nds) =>
      nds.map((node, idx) => ({
        ...node,
        position: {
          x: 40 + (idx % 3) * 410,
          y: 40 + Math.floor(idx / 3) * 340,
        },
      }))
    );
  };

  const handleSaveLayout = async () => {
    if (!connection) return;
    setSavingLayout(true);
    try {
      const positions: DiagramNodePosition[] = nodes.map((n) => ({
        tableKey: n.id,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
      }));
      await api.saveDiagramLayout(connection.id, positions);
      setSavedPositions(positions);
      onToast('success', 'Diagram layout saved', 'Table positions stored in workspace metadata.');
    } catch (err) {
      onToast('error', 'Could not save layout', err instanceof Error ? err.message : 'Error');
    } finally {
      setSavingLayout(false);
    }
  };

  const handleExportSvg = () => {
    if (!snapshot) return;
    const width = 1100;
    const height = Math.max(500, Math.ceil(nodes.length / 3) * 300 + 80);
    const rects = nodes
      .map((n) => {
        const tbl = n.data.table;
        const cols = tbl.columns
          .slice(0, 8)
          .map(
            (c, i) =>
              `<text x="${n.position.x + 12}" y="${n.position.y + 48 + i * 18}" font-family="monospace" font-size="11" fill="#1B2340">${c.name} (${c.sqlType})</text>`
          )
          .join('');
        return `<g>
          <rect x="${n.position.x}" y="${n.position.y}" width="260" height="${40 + Math.min(tbl.columns.length, 8) * 18 + 14}" rx="8" fill="#ffffff" stroke="#cbd5e1" />
          <rect x="${n.position.x}" y="${n.position.y}" width="260" height="28" rx="8" fill="#13172B" />
          <text x="${n.position.x + 12}" y="${n.position.y + 18}" font-family="sans-serif" font-size="12" font-weight="600" fill="#ffffff">${tbl.fullName}</text>
          ${cols}
        </g>`;
      })
      .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#F7F8FC"/>${rects}</svg>`;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${snapshot.databaseName}-diagram.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sourceTblObj = snapshot?.tables.find((t) => t.fullName === sourceTableKey);
  const targetTblObj = snapshot?.tables.find((t) => t.fullName === targetTableKey);
  const srcColObj = sourceTblObj?.columns.find((c) => c.name === sourceColumn);
  const tgtColObj = targetTblObj?.columns.find((c) => c.name === targetColumn);
  const typesCompatible =
    srcColObj && tgtColObj
      ? areColumnTypesCompatibleForFk(srcColObj.friendlyType, tgtColObj.friendlyType)
      : true;

  const handleStageRelationship = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connection || !sourceTblObj || !targetTblObj) return;
    try {
      const constraintName = `FK_${sourceTblObj.tableName}_${sourceColumn}_${targetTblObj.tableName}`;
      await api.createPlan(connection.id, `Link ${sourceTblObj.tableName}.${sourceColumn} → ${targetTblObj.tableName}.${targetColumn}`, [
        {
          kind: 'ADD_FOREIGN_KEY',
          constraintName,
          sourceSchema: sourceTblObj.schemaName,
          sourceTable: sourceTblObj.tableName,
          sourceColumn,
          targetSchema: targetTblObj.schemaName,
          targetTable: targetTblObj.tableName,
          targetColumn,
          onDelete,
          onUpdate,
        },
      ]);
      await onPlanCreated();
      setFkModalOpen(false);
      onToast('success', 'Relationship plan staged', 'Review and apply the Foreign Key in Change Center.');
      onNavigate('changes');
    } catch (err) {
      onToast('error', 'Invalid relationship', err instanceof Error ? err.message : 'Validation failed');
    }
  };

  if (!connection || !snapshot) {
    return (
      <div className="max-w-3xl mx-auto rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-8 text-center space-y-3">
        <h2 className="font-display text-lg font-semibold text-[#1B2340] dark:text-white">
          No schema loaded for visual design
        </h2>
        <p className="text-xs text-slate-500">Connect a database or load the interactive sample sandbox first.</p>
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

  return (
    <div className="h-[calc(100vh-7.5rem)] flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-xl font-bold text-[#1B2340] dark:text-white">
            Visual Database Designer
          </h1>
          <div className="relative">
            <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              aria-label="Highlight table on canvas"
              placeholder="Find table..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] pl-8 pr-3 py-1.5 text-xs text-[#1B2340] dark:text-white"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setSourceTableKey(snapshot.tables[0]?.fullName ?? '');
              setSourceColumn(snapshot.tables[0]?.columns[0]?.name ?? '');
              setTargetTableKey(snapshot.tables[1]?.fullName ?? snapshot.tables[0]?.fullName ?? '');
              setTargetColumn(snapshot.tables[1]?.columns[0]?.name ?? '');
              setFkModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] text-xs font-medium hover:bg-slate-50 dark:hover:bg-[#181F38]"
          >
            <Link2 className="h-3.5 w-3.5 text-[#6D4AFF]" />
            <span>Link Tables</span>
          </button>
          <button
            type="button"
            onClick={handleAutoLayout}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] text-xs font-medium hover:bg-slate-50 dark:hover:bg-[#181F38]"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            <span>Auto Layout</span>
          </button>
          <button
            type="button"
            disabled={savingLayout}
            onClick={handleSaveLayout}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] text-xs font-medium hover:bg-slate-50 dark:hover:bg-[#181F38]"
          >
            <Save className="h-3.5 w-3.5" />
            <span>{savingLayout ? 'Saving...' : 'Save Layout'}</span>
          </button>
          <button
            type="button"
            onClick={handleExportSvg}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] text-xs font-medium hover:bg-slate-50 dark:hover:bg-[#181F38]"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export SVG</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('table-builder')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#6D4AFF] hover:bg-[#5B38F0] text-white text-xs font-medium"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New Table</span>
          </button>
        </div>
      </div>

      {/* Responsive Desktop-First Hint */}
      <div className="md:hidden rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
        ER diagram editing is optimized for desktop viewports; use Explorer or Records for compact mobile inspection.
      </div>

      {/* React Flow Canvas */}
      <div
        data-testid="er-diagram-canvas"
        className="flex-1 rounded-xl border border-[#E2E6F0] dark:border-[#232B45] bg-white dark:bg-[#12172B] overflow-hidden"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={handleConnect}
          nodeTypes={nodeTypes}
          fitView
        >
          <Background gap={20} size={1} color="#94a3b8" className="opacity-25" />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>

      {/* Foreign Key Configuration Modal */}
      {fkModalOpen && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/50">
          <form
            onSubmit={handleStageRelationship}
            className="w-full max-w-lg rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4"
          >
            <h2 className="font-display text-base font-semibold text-[#1B2340] dark:text-white">
              Configure Table Relationship (Foreign Key)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Links a child field to a Primary Key or Unique field on a parent table. Changes enter the Change Center for review before applying.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Child Table (Source)</label>
                <select
                  value={sourceTableKey}
                  onChange={(e) => {
                    setSourceTableKey(e.target.value);
                    const t = snapshot.tables.find((x) => x.fullName === e.target.value);
                    setSourceColumn(t?.columns[0]?.name ?? '');
                  }}
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2.5 py-2 text-xs font-mono"
                >
                  {snapshot.tables.map((t) => (
                    <option key={t.fullName} value={t.fullName}>
                      {t.fullName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Child Column</label>
                <select
                  value={sourceColumn}
                  onChange={(e) => setSourceColumn(e.target.value)}
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2.5 py-2 text-xs font-mono"
                >
                  {(sourceTblObj?.columns ?? []).map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name} ({c.sqlType})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Parent Table (Target)</label>
                <select
                  value={targetTableKey}
                  onChange={(e) => {
                    setTargetTableKey(e.target.value);
                    const t = snapshot.tables.find((x) => x.fullName === e.target.value);
                    setTargetColumn(t?.primaryKeyColumns[0] ?? t?.columns[0]?.name ?? '');
                  }}
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2.5 py-2 text-xs font-mono"
                >
                  {snapshot.tables.map((t) => (
                    <option key={t.fullName} value={t.fullName}>
                      {t.fullName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Referenced Key Column</label>
                <select
                  value={targetColumn}
                  onChange={(e) => setTargetColumn(e.target.value)}
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2.5 py-2 text-xs font-mono"
                >
                  {(targetTblObj?.columns ?? []).map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name} ({c.sqlType})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">On Delete Behavior</label>
                <select
                  value={onDelete}
                  onChange={(e) => setOnDelete(e.target.value as 'NO ACTION' | 'CASCADE' | 'SET NULL')}
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2.5 py-2 text-xs"
                >
                  <option value="NO ACTION">Block Delete (NO ACTION)</option>
                  <option value="SET NULL">Set Empty (SET NULL)</option>
                  <option value="CASCADE">Delete Child Rows (CASCADE)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">On Update Behavior</label>
                <select
                  value={onUpdate}
                  onChange={(e) => setOnUpdate(e.target.value as 'NO ACTION' | 'CASCADE')}
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-2.5 py-2 text-xs"
                >
                  <option value="NO ACTION">NO ACTION</option>
                  <option value="CASCADE">CASCADE</option>
                </select>
              </div>
            </div>

            {!typesCompatible && (
              <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-2.5 text-xs text-[#E5484D]">
                Incompatible column types: {srcColObj?.sqlType} cannot link to {tgtColObj?.sqlType}.
              </div>
            )}

            {onDelete === 'CASCADE' && (
              <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-2.5 text-xs text-amber-800 dark:text-amber-300">
                Cascade Delete warning: deleting a parent record will automatically delete linked child records. Requires heightened confirmation in Change Center.
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setFkModalOpen(false)}
                className="px-3 py-1.5 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!typesCompatible || sourceTableKey === targetTableKey}
                className="px-4 py-1.5 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium disabled:opacity-50"
              >
                Stage Relationship Plan
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
