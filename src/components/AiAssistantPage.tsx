import React, { useState } from 'react';
import { Lock, Play, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import {
  AiSchemaProposal,
  ConnectionProfile,
  SchemaOperation,
  WorkspaceSummary,
} from '../shared/types';
import { NavSection } from './AppShell';

interface AiAssistantPageProps {
  workspace: WorkspaceSummary | null;
  aiProviderConfigured: boolean;
  connection: ConnectionProfile | null;
  onRefreshWorkspace: () => Promise<void>;
  onPlanCreated: () => Promise<void>;
  onOpenSqlInEditor: (sql: string) => void;
  onNavigate: (nav: NavSection) => void;
  onToast: (tone: 'success' | 'error' | 'info', title: string, detail?: string) => void;
}

export function AiAssistantPage({
  workspace,
  aiProviderConfigured,
  connection,
  onRefreshWorkspace,
  onPlanCreated,
  onOpenSqlInEditor,
  onNavigate,
  onToast,
}: AiAssistantPageProps) {
  const [tab, setTab] = useState<'schema' | 'query'>('schema');
  const [prompt, setPrompt] = useState('');
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [proposal, setProposal] = useState<AiSchemaProposal | null>(null);
  const [sqlOutput, setSqlOutput] = useState<{ sql: string; explanation: string } | null>(null);

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

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#1B2340] dark:text-white">
            AI Database Assistant
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Drafts schemas and read-only SELECT queries from metadata only. Never sends row contents or executes autonomously.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg bg-[#F1F3F9] dark:bg-[#181F38] border border-[#E2E6F0] dark:border-[#232B45]">
          <button
            type="button"
            onClick={() => setTab('schema')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${
              tab === 'schema'
                ? 'bg-white dark:bg-[#12172B] text-[#6D4AFF] shadow-xs'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            Schema Drafting
          </button>
          <button
            type="button"
            onClick={() => setTab('query')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${
              tab === 'query'
                ? 'bg-white dark:bg-[#12172B] text-[#6D4AFF] shadow-xs'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            Natural-Language Read Query
          </button>
        </div>
      </div>

      {/* Explicit Consent & Provider Gate */}
      {(!aiProviderConfigured || !aiEnabled) && (
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
              ? 'Server-side GEMINI_API_KEY is not configured in this environment. Visual Database Studio never fabricates AI responses without a live provider.'
              : 'Per our privacy policy, AI schema drafting and NL-to-SQL are disabled by default. When enabled, only table and column names (never customer table rows) are shared with the model.'}
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
      )}

      {aiProviderConfigured && aiEnabled && (
        <>
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Metadata-only AI consent active for {workspace?.name}.</span>
            {canConfigure && (
              <button type="button" onClick={handleToggleConsent} className="text-[#E5484D] hover:underline">
                Disable AI Access
              </button>
            )}
          </div>

          {tab === 'schema' ? (
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
          ) : (
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
        </>
      )}
    </div>
  );
}
