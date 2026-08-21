import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(packageRoot, '.env');

// Locally, MCP clients launch the server with an arbitrary cwd, so .env is read
// from the package root rather than process.cwd(). On Vercel there is no .env
// file — the values come from the project's environment variables.
// quiet: dotenv writes its banner to stdout, which is the MCP wire protocol.
if (!process.env.VERCEL) {
  dotenv.config({ path: envPath, quiet: true });
}

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const num = (value, fallback) => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
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
   * Output budget. Retrieval stays wide (topK) but only the strongest tables
   * are rendered — retrieval is cheap, tokens in the answer are not.
   */
  maxTables: int(process.env.MAX_TABLES, 4),
  maxCharsPerTable: int(process.env.MAX_CHARS_PER_TABLE, 1400),
  maxResponseChars: int(process.env.MAX_RESPONSE_CHARS, 7000),

  /**
   * When retrieval cannot pick a winner, ask the user instead of dumping every
   * candidate. The test is the size of the biggest score drop in the top
   * results, as a fraction of the best score: below `ambiguityGap` the ranking
   * is flat and nothing really matched. Raise it to be asked more often, lower
   * it to be asked less. `minScore` is an extra absolute floor; 0 disables it.
   */
  askWhenUnsure: bool(process.env.ASK_WHEN_UNSURE, true),
  /** Ask the user directly via MCP elicitation when the client supports it. */
  elicit: bool(process.env.ELICIT, true),
  ambiguityGap: num(process.env.AMBIGUITY_GAP, 0.015),
  minScore: num(process.env.MIN_SCORE, 0),
  maxCandidates: int(process.env.MAX_CANDIDATES, 8),

  /** In-process cache TTL for searches, table fetches and the table list. 0 disables. */
  cacheTtlMs: int(process.env.CACHE_TTL_MS, 600_000),

  /**
   * Only used when the index does NOT have integrated embedding. This MUST be
   * the model the schema was upserted with, or every score is noise.
   */
  embedModel: process.env.EMBED_MODEL || 'multilingual-e5-large',

  /** Metadata fields that may hold the schema text, most specific first. */
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

  /** Metadata fields that may hold the table name. */
  tableFields: list(process.env.TABLE_FIELDS, ['table', 'table_name', 'tableName', 'entity', 'name']),

  /** Metadata fields that may hold the database name. */
  dbFields: list(process.env.DB_FIELDS, ['db', 'database', 'schema_name', 'catalog']),

  /**
   * Scope every lookup to one database. Leave empty to search all of them —
   * but if the index holds several environments of the same schema, setting
   * this stops the LLM mixing tables across them.
   */
  defaultDatabase: process.env.DEFAULT_DATABASE || '',

  /** Purely informational: passed to the LLM so it writes the right SQL flavour. */
  sqlDialect: process.env.SQL_DIALECT || 'MySQL',

  /** Safety cap for list_tables scans. */
  listScanLimit: int(process.env.LIST_SCAN_LIMIT, 1000),

  /** Names printed by list_tables before it tells the caller to use `filter`. */
  maxListedTables: int(process.env.MAX_LISTED_TABLES, 120),

  /** Record batches fetched in parallel while scanning the index. */
  scanConcurrency: int(process.env.SCAN_CONCURRENCY, 6),

  /**
   * How long a search will wait for a table scan that is still warming up
   * before answering without name matching. 0 never waits.
   */
  inventoryWaitMs: int(process.env.INVENTORY_WAIT_MS, 3000),
};

export function assertConfig() {
  if (!config.apiKey) {
    throw new Error(
      process.env.VERCEL
        ? 'PINECONE_API_KEY is not set. Add it under Project Settings → Environment Variables, then redeploy.'
        : `PINECONE_API_KEY is not set. Add it to ${envPath}.`,
    );
  }
}
