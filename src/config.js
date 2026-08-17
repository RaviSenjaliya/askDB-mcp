import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// MCP clients launch the server with an arbitrary cwd, so load .env from the
// package root instead of relying on process.cwd().
const here = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(here, '..');

// quiet: dotenv writes its banner to stdout, which is the MCP wire protocol.
dotenv.config({ path: path.join(packageRoot, '.env'), quiet: true });

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (value, fallback) =>
  value
    ? value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : fallback;

export const config = {
  apiKey: process.env.PINECONE_API_KEY,
  indexName: process.env.PINECONE_INDEX || 'ask-db',
  /** '' means the default namespace. */
  namespace: process.env.PINECONE_NAMESPACE || '',

  defaultTopK: int(process.env.TOP_K, 8),
  maxTopK: int(process.env.MAX_TOP_K, 30),

  /**
   * Only used when the index does NOT have integrated embedding. This MUST be
   * the model the schema was upserted with, or every score is noise.
   */
  embedModel: process.env.EMBED_MODEL || 'multilingual-e5-large',
  /** Set to e.g. bge-reranker-v2-m3 to rerank hits; empty disables reranking. */
  rerankModel: process.env.RERANK_MODEL || '',
  /** With reranking on, retrieve topK × this, then rerank down to topK. */
  rerankOverfetch: int(process.env.RERANK_OVERFETCH, 4),
  /** Per-document cap sent to the reranker, so long DDL does not bloat the request. */
  rerankMaxChars: int(process.env.RERANK_MAX_CHARS, 4000),

  /** Metadata/record fields that may hold the schema text, most specific first. */
  textFields: list(process.env.TEXT_FIELDS, [
    'chunk_text',
    'text',
    'schema',
    'ddl',
    'create_statement',
    'content',
    'body',
    'description',
  ]),

  /** Metadata/record fields that may hold the table name. */
  tableFields: list(process.env.TABLE_FIELDS, [
    'table',
    'table_name',
    'tableName',
    'entity',
    'name',
  ]),

  /** Metadata/record fields that may hold the database name. */
  dbFields: list(process.env.DB_FIELDS, ['db', 'database', 'schema_name', 'catalog']),

  /**
   * Scope every lookup to one database. Leave empty to search all of them —
   * but if the index holds several environments of the same schema, setting
   * this stops the LLM mixing tables across them.
   */
  defaultDatabase: process.env.DEFAULT_DATABASE || '',

  /** Purely informational: passed to the LLM so it writes the right SQL flavour. */
  sqlDialect: process.env.SQL_DIALECT || 'ANSI SQL',

  /** Safety cap for list_tables scans. */
  listScanLimit: int(process.env.LIST_SCAN_LIMIT, 1000),
};

export function assertConfig() {
  if (!config.apiKey) {
    throw new Error(
      `PINECONE_API_KEY is not set. Copy .env.example to .env (${path.join(packageRoot, '.env')}) and fill it in.`,
    );
  }
}
