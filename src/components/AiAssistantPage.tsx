import React, { useState } from 'react';
import {
  BookOpen,
  Download,
  FileText,
  Link2,
  Lock,
  Play,
  Sparkles,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  AiRelationshipSuggestion,
  AiSchemaProposal,
  ConnectionProfile,
  SchemaOperation,
  SchemaSnapshot,
  WorkspaceSummary,
} from '../shared/types';
import { NavSection } from './AppShell';

interface AiAssistantPageProps {
  workspace: WorkspaceSummary | null;
  aiProviderConfigured: boolean;
  connection: ConnectionProfile | null;
  snapshot: SchemaSnapshot | null;
  onRefreshWorkspace: () => Promise<void>;
  onPlanCreated: () => Promise<void>;
  onOpenSqlInEditor: (sql: string) => void;
  onNavigate: (nav: NavSection) => void;
  onToast: (tone: 'success' | 'error' | 'info', title: string, detail?: string) => void;
}

type AiTab = 'schema' | 'query' | 'explain' | 'relationships' | 'docs';

export function AiAssistantPage({
  workspace,
  aiProviderConfigured,
  connection,
  snapshot,
  onRefreshWorkspace,
  onPlanCreated,
  onOpenSqlInEditor,
  onNavigate,
  onToast,
}: AiAssistantPageProps) {
  const [tab, setTab] = useState<AiTab>('schema');
  const [prompt, setPrompt] = useState('');
  const [question, setQuestion] = useState('');
  const [sqlToExplain, setSqlToExplain] = useState('');
  const [loading, setLoading] = useState(false);

  const [proposal, setProposal] = useState<AiSchemaProposal | null>(null);
  const [sqlOutput, setSqlOutput] = useState<{ sql: string; explanation: string } | null>(null);
  const [explainOutput, setExplainOutput] = useState<{
    summary: string;
    steps: string[];
    safetyNotes: string[];
  } | null>(null);
  const [relSuggestions, setRelSuggestions] = useState<AiRelationshipSuggestion[] | null>(null);
  const [docsOutput, setDocsOutput] = useState<{ markdown: string; source: 'gemini' | 'deterministic' } | null>(null);

  const policy = workspace?.policy;
  const aiEnabled = Boolean(policy?.aiAssistantEnabled && policy?.aiSchemaSharingConsent);
  const canConfigure =
    workspace?.currentActor.role === 'Owner' || workspace?.currentActor.role === 'Admin';

  const handleToggleConsent = async () => {
    try {
      await api.updatePolicy({
        aiAssistantEnabled: !aiEnabled,
        aiSchemaSharingConsent: !aiEnabled,
      });
      await onRefreshWorkspace();
      onToast(
        'info',
        !aiEnabled ? 'AI Assistant enabled' : 'AI Assistant disabled',
        !aiEnabled
          ? 'Schema metadata-only sharing consent recorded for this workspace.'
          : 'AI features turned off.'
      );
    } catch (err) {
      onToast('error', 'Failed to update AI setting', err instanceof Error ? err.message : 'Error');
    }
  };

  const handleGenerateSchema = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setProposal(null);
    try {
      const res = await api.aiSchemaDraft(prompt, connection?.id);
      setProposal(res.proposal);
    } catch (err) {
      onToast('error', 'AI drafting failed', err instanceof Error ? err.message : 'Error');
    } finally {
      setLoading(false);
    }
  };

  const handleStageProposal = async () => {
    if (!connection || !proposal) {
      onToast('error', 'Connect a database first', 'Select an active database connection to stage this draft.');
      return;
    }
    const ops: SchemaOperation[] = proposal.tables.map((t) => ({
      kind: 'CREATE_TABLE',
      schemaName: t.schemaName || 'dbo',
      tableName: t.tableName,
      description: t.purpose,
      fields: t.fields,
    }));
    try {
      await api.createPlan(connection.id, `AI Draft: ${proposal.summary.slice(0, 60)}`, ops);
      await onPlanCreated();
      onToast('success', 'AI draft staged in Change Center', 'Review SQL and preflight checks before applying.');
      onNavigate('changes');
    } catch (err) {
      onToast('error', 'Could not stage AI draft', err instanceof Error ? err.message : 'Validation failed');
    }
  };

  const handleGenerateQuery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connection) {
      onToast('error', 'Select a connection', 'Connect a database first.');
      return;
    }
    setLoading(true);
    setSqlOutput(null);
    try {
      const res = await api.aiNlQuery(question, connection.id);
      setSqlOutput(res);
    } catch (err) {
      onToast('error', 'AI query failed', err instanceof Error ? err.message : 'Error');
    } finally {
      setLoading(false);
    }
  };

  const handleExplainSql = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setExplainOutput(null);
    try {
      const res = await api.aiExplainSql(sqlToExplain, connection?.id);
      setExplainOutput(res);
    } catch (err) {
      onToast('error', 'Explanation failed', err instanceof Error ? err.message : 'Error');
    } finally {
      setLoading(false);
    }
  };

  const handleSuggestRelationships = async () => {
    if (!connection) {
      onToast('error', 'Select a connection', 'Connect a database first.');
      return;
    }
    setLoading(true);
    setRelSuggestions(null);
    try {
      const res = await api.aiSuggestRelationships(connection.id);
      setRelSuggestions(res.suggestions);
    } catch (err) {
      onToast('error', 'Suggestion failed', err instanceof Error ? err.message : 'Error');
    } finally {
      setLoading(false);
    }
  };

  const handleStageSuggestedFk = async (sug: AiRelationshipSuggestion) => {
    if (!connection) return;
    try {
      await api.createPlan(
        connection.id,
        `Suggested FK: ${sug.sourceTable}.${sug.sourceColumn} → ${sug.targetTable}.${sug.targetColumn}`,
        [
          {
            kind: 'ADD_FOREIGN_KEY',
            constraintName: `FK_${sug.sourceTable}_${sug.sourceColumn}_${sug.targetTable}`,
            sourceSchema: sug.sourceSchema,
            sourceTable: sug.sourceTable,
            sourceColumn: sug.sourceColumn,
            targetSchema: sug.targetSchema,
            targetTable: sug.targetTable,
            targetColumn: sug.targetColumn,
            onDelete: 'NO ACTION',
            onUpdate: 'NO ACTION',
          },
        ]
      );
      await onPlanCreated();
      onToast('success', 'Relationship staged in Change Center', 'Explicit approval required before executing.');
      onNavigate('changes');
    } catch (err) {
      onToast('error', 'Could not stage suggestion', err instanceof Error ? err.message : 'Error');
    }
  };

  const handleGenerateDocs = async (useAi: boolean) => {
    if (!connection) {
      onToast('error', 'Select a connection', 'Connect a database first.');
      return;
    }
    setLoading(true);
    setDocsOutput(null);
    try {
      const res = await api.aiGenerateDocs(connection.id, useAi);
      setDocsOutput(res);
    } catch (err) {
      onToast('error', 'Documentation generation failed', err instanceof Error ? err.message : 'Error');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadDocs = () => {
    if (!docsOutput) return;
    const blob = new Blob([docsOutput.markdown], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${snapshot?.databaseName ?? 'database'}-documentation.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const showProviderGate = tab !== 'docs' && (!aiProviderConfigured || !aiEnabled);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#1B2340] dark:text-white">
            AI Database Assistant
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Generates schema proposals, T-SQL queries, explanations, FK suggestions, and Markdown docs. Never executes changes without approval.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 rounded-lg bg-[#F1F3F9] dark:bg-[#181F38] border border-[#E2E6F0] dark:border-[#232B45]">
          {(
            [
              { id: 'schema', label: 'Schema Draft' },
              { id: 'query', label: 'NL to SQL' },
              { id: 'explain', label: 'Explain SQL' },
              { id: 'relationships', label: 'Suggest Links' },
              { id: 'docs', label: 'DB Docs' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
                tab === t.id
                  ? 'bg-white dark:bg-[#12172B] text-[#6D4AFF] shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {showProviderGate ? (
        <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-6 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#1B2340] dark:text-white">
            <Lock className="h-4 w-4 text-[#6D4AFF]" />
            <span>
              {!aiProviderConfigured
                ? 'AI Provider Not Configured on Server'
                : 'Workspace Opt-In Consent Required'}
            </span>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            {!aiProviderConfigured
              ? 'Server-side GEMINI_API_KEY is not configured in this environment. Visual Database Studio never fabricates generative AI answers without a live API key. You can still switch to the "DB Docs" tab for deterministic offline Markdown documentation.'
              : 'Per our privacy policy, AI metadata sharing is opt-in. Only table and column metadata (never customer row data) are sent.'}
          </p>
          {aiProviderConfigured && canConfigure && (
            <button
              type="button"
              onClick={handleToggleConsent}
              className="px-4 py-2 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium"
            >
              Enable AI Assistant with Metadata-Only Consent
            </button>
          )}
        </section>
      ) : (
        <>
          {aiProviderConfigured && aiEnabled && (
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>Metadata-only AI consent active for {workspace?.name}.</span>
              {canConfigure && (
                <button type="button" onClick={handleToggleConsent} className="text-[#E5484D] hover:underline">
                  Disable AI Access
                </button>
              )}
            </div>
          )}

          {tab === 'schema' && (
            <div className="space-y-4">
              <form
                onSubmit={handleGenerateSchema}
                className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-3"
              >
                <label htmlFor="ai-schema-prompt" className="block text-xs font-semibold text-[#1B2340] dark:text-white">
                  Describe the tables you want to design
                </label>
                <textarea
                  id="ai-schema-prompt"
                  rows={3}
                  required
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="e.g. Create an equipment maintenance tracker with assets, service schedules, technicians, and work orders."
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] p-3 text-sm"
                />
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={loading}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>{loading ? 'Drafting Schema...' : 'Generate Draft Proposal'}</span>
                  </button>
                </div>
              </form>

              {proposal && (
                <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                      <h2 className="font-display text-base font-semibold text-[#1B2340] dark:text-white">
                        {proposal.summary}
                      </h2>
                      <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                        {proposal.plainExplanation}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleStageProposal}
                      className="px-4 py-2 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium shrink-0"
                    >
                      Stage in Change Center
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {proposal.tables.map((t) => (
                      <div key={t.tableName} className="rounded-lg border border-[#E2E6F0] dark:border-[#232B45] p-3 space-y-2">
                        <div className="font-mono text-xs font-semibold text-[#1B2340] dark:text-white">
                          {t.schemaName}.{t.tableName}
                        </div>
                        <p className="text-[11px] text-slate-500">{t.purpose}</p>
                        <ul className="space-y-1 text-xs font-mono">
                          {t.fields.map((f) => (
                            <li key={f.name} className="flex justify-between text-slate-600 dark:text-slate-300">
                              <span>{f.name}</span>
                              <span className="text-slate-400">{f.friendlyType}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {tab === 'query' && (
            <div className="space-y-4">
              <form
                onSubmit={handleGenerateQuery}
                className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-3"
              >
                <label htmlFor="ai-nl-query" className="block text-xs font-semibold text-[#1B2340] dark:text-white">
                  Ask a read-only question about your schema
                </label>
                <input
                  id="ai-nl-query"
                  type="text"
                  required
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="e.g. Show active projects ordered by allocated budget descending"
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#F7F8FC] dark:bg-[#181F38] px-3 py-2 text-sm"
                />
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={loading}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>{loading ? 'Translating...' : 'Generate SELECT Preview'}</span>
                  </button>
                </div>
              </form>

              {sqlOutput && (
                <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-3">
                  <p className="text-xs text-slate-600 dark:text-slate-300">{sqlOutput.explanation}</p>
                  <div className="rounded-lg bg-[#13172B] text-slate-100 p-3.5">
                    <pre className="text-xs font-mono whitespace-pre-wrap">{sqlOutput.sql}</pre>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => onOpenSqlInEditor(sqlOutput.sql)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium"
                    >
                      <Play className="h-3.5 w-3.5" />
                      <span>Review & Run in SQL Editor</span>
                    </button>
                  </div>
                </section>
              )}
            </div>
          )}

          {tab === 'explain' && (
            <div className="space-y-4">
              <form
                onSubmit={handleExplainSql}
                className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-3"
              >
                <label htmlFor="ai-explain-sql" className="block text-xs font-semibold text-[#1B2340] dark:text-white">
                  Paste T-SQL or SQL script to analyze and explain safely
                </label>
                <textarea
                  id="ai-explain-sql"
                  rows={5}
                  required
                  value={sqlToExplain}
                  onChange={(e) => setSqlToExplain(e.target.value)}
                  placeholder="SELECT TOP (50) ..."
                  className="w-full rounded-lg border border-[#E2E6F0] dark:border-[#232B45] bg-[#13172B] text-slate-100 p-3 text-xs font-mono"
                />
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={loading}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium disabled:opacity-50"
                  >
                    <BookOpen className="h-3.5 w-3.5" />
                    <span>{loading ? 'Analyzing SQL...' : 'Explain SQL Statement'}</span>
                  </button>
                </div>
              </form>

              {explainOutput && (
                <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-3 text-xs">
                  <div className="font-semibold text-sm text-[#1B2340] dark:text-white">
                    {explainOutput.summary}
                  </div>
                  {explainOutput.steps.length > 0 && (
                    <div>
                      <div className="font-semibold text-slate-600 dark:text-slate-300 mb-1">Execution Breakdown</div>
                      <ul className="list-disc pl-5 space-y-1 text-slate-600 dark:text-slate-400">
                        {explainOutput.steps.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {explainOutput.safetyNotes.length > 0 && (
                    <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3 space-y-1 text-amber-900 dark:text-amber-200">
                      <div className="font-semibold">Safety & Performance Notes</div>
                      <ul className="list-disc pl-4 space-y-0.5">
                        {explainOutput.safetyNotes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              )}
            </div>
          )}

          {tab === 'relationships' && (
            <div className="space-y-4">
              <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <h2 className="font-display text-sm font-semibold text-[#1B2340] dark:text-white">
                    Foreign Key Relationship Suggestions
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Inspects unlinked columns across {snapshot?.databaseName ?? 'the active schema'} and recommends missing foreign keys for explicit review.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={loading || !connection}
                  onClick={handleSuggestRelationships}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium disabled:opacity-50 shrink-0"
                >
                  <Link2 className="h-3.5 w-3.5" />
                  <span>{loading ? 'Analyzing Schema...' : 'Analyze Relationships'}</span>
                </button>
              </section>

              {relSuggestions && (
                <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] divide-y divide-[#E2E6F0] dark:divide-[#232B45]">
                  {relSuggestions.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-500">
                      No missing foreign keys suggested for this schema.
                    </div>
                  ) : (
                    relSuggestions.map((s, i) => (
                      <div key={i} className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs">
                        <div>
                          <div className="font-mono font-semibold text-[#1B2340] dark:text-white">
                            {s.sourceSchema}.{s.sourceTable}.{s.sourceColumn} → {s.targetSchema}.{s.targetTable}.{s.targetColumn}
                          </div>
                          <p className="text-slate-500 dark:text-slate-400 mt-0.5">
                            Confidence: {s.confidence} · {s.reason}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleStageSuggestedFk(s)}
                          className="px-3 py-1.5 rounded-lg border border-[#6D4AFF] text-[#6D4AFF] font-medium hover:bg-[#6D4AFF]/10 shrink-0"
                        >
                          Stage Foreign Key
                        </button>
                      </div>
                    ))
                  )}
                </section>
              )}
            </div>
          )}

          {tab === 'docs' && (
            <div className="space-y-4">
              <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <h2 className="font-display text-sm font-semibold text-[#1B2340] dark:text-white">
                    Schema Markdown Documentation Generator
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Produces structured Markdown data dictionaries from catalog metadata (deterministic offline mode always works; optionally enriched with Gemini).
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={loading || !connection}
                    onClick={() => handleGenerateDocs(false)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#E2E6F0] dark:border-[#232B45] text-xs font-medium hover:bg-slate-50 dark:hover:bg-[#181F38] disabled:opacity-50"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    <span>Generate Standard Docs</span>
                  </button>
                  {aiProviderConfigured && aiEnabled && (
                    <button
                      type="button"
                      disabled={loading || !connection}
                      onClick={() => handleGenerateDocs(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#6D4AFF] text-white text-xs font-medium disabled:opacity-50"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>AI Enriched Docs</span>
                    </button>
                  )}
                </div>
              </section>

              {docsOutput && (
                <section className="rounded-xl bg-white dark:bg-[#12172B] border border-[#E2E6F0] dark:border-[#232B45] p-5 space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500">Source: {docsOutput.source}</span>
                    <button
                      type="button"
                      onClick={handleDownloadDocs}
                      className="inline-flex items-center gap-1 text-[#6D4AFF] font-medium hover:underline"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download .md</span>
                    </button>
                  </div>
                  <pre className="rounded-lg bg-[#13172B] text-slate-100 p-4 text-xs font-mono whitespace-pre-wrap max-h-96 overflow-y-auto">
                    {docsOutput.markdown}
                  </pre>
                </section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
