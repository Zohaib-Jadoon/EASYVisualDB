import { GoogleGenAI, Type } from '@google/genai';
import { AiSchemaProposal, SchemaSnapshot } from '../shared/types';

function getGeminiClient(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function isAiProviderConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY;
  return Boolean(key && key !== 'MY_GEMINI_API_KEY');
}

export async function generateSchemaDraftWithAi(
  prompt: string,
  existingSnapshot: SchemaSnapshot | null
): Promise<AiSchemaProposal> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error(
      'AI provider credentials (GEMINI_API_KEY) are not configured on the server. Visual Database Studio does not invent simulated AI responses.'
    );
  }

  const existingSummary = existingSnapshot
    ? existingSnapshot.tables.map((t) => `${t.fullName}(${t.columns.map((c) => c.name).join(', ')})`).join('; ')
    : 'Empty database (no existing tables).';

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: `Design a normalized Microsoft SQL Server database schema draft for this request:\n"${prompt}"\n\nExisting tables (metadata only, no row data): ${existingSummary}`,
    config: {
      systemInstruction:
        'You are a senior Microsoft SQL Server architect. Output strictly structured schema drafts using friendlyType values from: auto_id, text, long_text, integer, decimal, money, date, datetime, boolean, uuid. Always use PascalCase or snake_case valid SQL identifiers without spaces. Every table should include an auto_id primary key.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          plainExplanation: { type: Type.STRING },
          tables: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                schemaName: { type: Type.STRING },
                tableName: { type: Type.STRING },
                purpose: { type: Type.STRING },
                fields: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING },
                      friendlyType: { type: Type.STRING },
                      length: { type: Type.INTEGER },
                      nullable: { type: Type.BOOLEAN },
                      isPrimaryKey: { type: Type.BOOLEAN },
                      isIdentity: { type: Type.BOOLEAN },
                      isUnique: { type: Type.BOOLEAN },
                    },
                  },
                },
              },
            },
          },
          relationships: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                sourceTable: { type: Type.STRING },
                sourceColumn: { type: Type.STRING },
                targetTable: { type: Type.STRING },
                targetColumn: { type: Type.STRING },
                reason: { type: Type.STRING },
              },
            },
          },
        },
      },
    },
  });

  const parsed = JSON.parse(response.text ?? '{}') as AiSchemaProposal;
  if (!parsed.tables || !Array.isArray(parsed.tables)) {
    throw new Error('AI response did not include valid table definitions.');
  }

  // Assign deterministic client IDs for fields
  parsed.tables = parsed.tables.map((t, ti) => ({
    ...t,
    schemaName: t.schemaName || 'dbo',
    fields: (t.fields || []).map((f, fi) => ({
      ...f,
      id: `ai_f_${ti}_${fi}`,
    })),
  }));

  return parsed;
}

export async function generateReadOnlySqlWithAi(
  question: string,
  snapshot: SchemaSnapshot
): Promise<{ sql: string; explanation: string }> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error(
      'AI provider credentials (GEMINI_API_KEY) are not configured on the server.'
    );
  }

  const schemaDesc = snapshot.tables
    .map(
      (t) =>
        `${t.fullName}: ${t.columns.map((c) => `${c.name} (${c.sqlType})`).join(', ')}`
    )
    .join('\n');

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: `Question: "${question}"\n\nDatabase schema metadata (no row data):\n${schemaDesc}`,
    config: {
      systemInstruction:
        'Generate a single read-only SELECT query with TOP (50) for Microsoft SQL Server using bracket-quoted identifiers like [dbo].[Employees]. Never emit INSERT, UPDATE, DELETE, DROP, or ALTER. Explain the query in plain language.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          sql: { type: Type.STRING },
          explanation: { type: Type.STRING },
        },
      },
    },
  });

  return JSON.parse(response.text ?? '{}') as { sql: string; explanation: string };
}
