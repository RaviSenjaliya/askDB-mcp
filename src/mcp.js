import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { config } from './config.js';
import {
  describeIndex,
  fetchTable,
  inventoryWithin,
  listNamespaces,
  peekInventory,
  scanTables,
  searchSchema,
} from './pinecone.js';
import {
  dedupeByTable,
  formatCandidates,
  formatEmpty,
  formatSchema,
  formatUnknownTables,
  groupByTable,
} from './format.js';
import { matchTables, similarTables } from './lexical.js';

const text = (value) => ({ content: [{ type: 'text', text: value }] });
const fail = (value) => ({ content: [{ type: 'text', text: value }], isError: true });

/** Handlers must never throw — the client would see a protocol error instead of a usable message. */
const guard = (handler) => async (args) => {
  try {
    return await handler(args);
  } catch (error) {
    return fail(`askDB error: ${error?.message ?? String(error)}`);
  }
};

/**
 * Sent once at handshake. Everything standing lives here rather than being
 * re-sent inside every tool result, which is where the old server spent most
 * of its tokens.
 */
const INSTRUCTIONS = [
  `askDB retrieves this project's ${config.sqlDialect} schema from a vector index. It has no live database connection and runs nothing.`,
  'Workflow: call `search_schema` with the user question verbatim before writing any SQL.',
  'If it answers with a numbered candidate list, STOP — show the list to the user, ask which table(s) they mean, then call `get_table_schema` with their answer. Never guess a table.',
  '`list_tables` is for orientation only; prefer `search_schema`.',
  'When writing SQL: use only tables and columns these tools returned, never invent names; quote identifiers with backticks; qualify as `database`.`table` when more than one database is in play; join only on keys visible in the DDL and say so when a relationship is missing.',
].join(' ');

const databaseArg = z
  .string()
  .optional()
  .describe(
    `Restrict to one database/schema${config.defaultDatabase ? ` (default \`${config.defaultDatabase}\`)` : ' — omit to search all of them'}.`,
  );
const namespaceArg = z.string().optional().describe('Pinecone namespace override.');
const detailArg = z
  .enum(['names', 'compact', 'full'])
  .optional()
  .describe(
    'names = table names only (cheapest); compact = trimmed DDL (default); full = every stored field, no trimming.',
  );

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * Decides whether retrieval actually picked a winner, by looking for a knee —
 * a decisive drop between one table and the next.
 *
 * Absolute scores say nothing here: every e5 cosine score sits near 0.8, so a
 * fixed floor would pass or fail everything at once. What separates "found it"
 * from "no idea" is the *shape* of the ranking. `0.91, 0.74, 0.70` has an
 * obvious cliff after the first table; `0.831, 0.830, 0.829, 0.828` is a flat
 * line and means the index could not tell these tables apart — which is
 * exactly when the user should be asked instead of guessed at.
 *
 * The knee also sizes the answer: a join question puts two tables above the
 * cliff and both get returned.
 */
export function assess(groups) {
  const top = finite(groups[0].score);
  if (config.minScore > 0 && top < config.minScore) {
    return { ask: true, reason: `best match scored ${top.toFixed(3)}, below the ${config.minScore} floor` };
  }
  if (groups.length === 1) return { ask: false, show: 1 };

  // Gaps as a fraction of the top score, so the threshold is scale-free.
  const scale = Math.abs(top) || 1;
  const limit = Math.min(config.maxTables, groups.length - 1);
  let knee = 0;
  let widest = 0;
  for (let index = 0; index < limit; index += 1) {
    const gap = (finite(groups[index].score) - finite(groups[index + 1].score)) / scale;
    if (gap > widest) {
      widest = gap;
      knee = index;
    }
  }

  if (widest < config.ambiguityGap) {
    return {
      ask: true,
      reason: `the top ${Math.min(groups.length, config.maxCandidates)} tables scored within ${(widest * 100).toFixed(1)}% of each other — retrieval could not separate them`,
    };
  }
  return { ask: false, show: knee + 1 };
}

/**
 * Which copy of a table wins when the index holds several environments of the
 * same schema: the caller's database, then the configured default, then the
 * one with the most tables — an index of `speed_core_live` (199 tables) and
 * `speed_core_test` (126) should answer from live unless told otherwise.
 */
function preferredDatabases(database) {
  const sizes = (peekInventory()?.databases ?? [])
    .slice()
    .sort((a, b) => b.tables.length - a.tables.length)
    .map((entry) => entry.database);
  return [...new Set([database, config.defaultDatabase, ...sizes].filter(Boolean))];
}

/**
 * Tables whose *name* answers the question, pulled from the cached inventory.
 * Only whole-name matches qualify, so this fires when it is nearly certain —
 * "how many payments last month" finds `tbl_payment`, which the embedding
 * ranked below four unrelated mapping tables.
 *
 * Skipped entirely while the inventory is still warming: it is an accelerator,
 * never a dependency.
 */
async function nameMatches({ question, database, namespace, already }) {
  const inventory = await inventoryWithin(config.inventoryWaitMs);
  if (!inventory) return [];

  const scope = database ?? config.defaultDatabase ?? '';
  const matches = matchTables(question, inventory, {
    database: scope,
    limit: config.maxTables,
    prefer: preferredDatabases(database),
  });
  if (!matches.length) return [];

  const resolved = await Promise.all(
    matches.map(async (match) => {
      // Already retrieved: promote it rather than fetching it a second time.
      const hit = already.find((group) => group.table === match.table);
      if (hit) return { ...hit, match: 'name' };

      const result = await fetchTable(match.table, { database: match.database, namespace }).catch(() => null);
      if (result?.matchedBy !== 'exact-metadata') return null;
      const [group] = groupByTable(result.hits);
      return group ? { ...group, name: match.name, match: 'name', score: null } : null;
    }),
  );
  return resolved.filter(Boolean);
}

/**
 * Asks the user directly when the client supports elicitation, saving the
 * extra round trip through the calling model. Any failure — unsupported,
 * declined, timed out — falls back to returning the candidate list as text.
 */
async function elicitTable(server, { question, candidates }) {
  if (!config.elicit) return null;
  try {
    if (!server.server.getClientCapabilities()?.elicitation) return null;
    const result = await server.server.elicitInput({
      message: `askDB: several tables could answer "${question}". Which one should I use?`,
      requestedSchema: {
        type: 'object',
        properties: {
          table: {
            type: 'string',
            title: 'Table',
            description: 'The table to read the schema from.',
            enum: candidates.map((group) => group.name),
          },
        },
        required: ['table'],
      },
    });
    if (result?.action !== 'accept') return null;
    const chosen = result.content?.table;
    return candidates.some((group) => group.name === chosen) ? chosen : null;
  } catch {
    return null;
  }
}

function registerTools(server) {
  server.registerTool(
    'search_schema',
    {
      title: 'Search database schema',
      description:
        'Semantic search over the schema index. Call this FIRST for any text-to-SQL request, passing the user question verbatim. Returns the DDL of the tables that match — or, when it cannot tell which table is meant, a short numbered list to put to the user.',
      inputSchema: {
        question: z
          .string()
          .min(3)
          .describe('The natural-language data question, e.g. "top 10 accounts by volume last month".'),
        tables: z
          .array(z.string())
          .optional()
          .describe('Restrict to these tables when the user has already named them. Disables the ambiguity check.'),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(config.maxTopK)
          .optional()
          .describe(`Chunks retrieved (default ${config.defaultTopK}); only the strongest tables are rendered.`),
        detail: detailArg,
        on_unsure: z
          .enum(['ask', 'best_effort'])
          .optional()
          .describe('ask (default) returns candidates for the user to choose from; best_effort answers anyway.'),
        database: databaseArg,
        namespace: namespaceArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ question, tables, top_k, detail = 'compact', on_unsure = 'ask', database, namespace }) => {
      const topK = top_k ?? config.defaultTopK;
      let note;
      let result;
      try {
        result = await searchSchema({ query: question, topK, tables, database, namespace });
      } catch (error) {
        if (!tables?.length) throw error;
        // The metadata filter referenced fields this index does not have.
        note = `table filter ${JSON.stringify(tables)} could not be applied — showing unfiltered matches`;
        result = await searchSchema({ query: question, topK, database, namespace });
      }

      const vector = dedupeByTable(groupByTable(result.hits), preferredDatabases(database));
      const exact = tables?.length
        ? []
        : await nameMatches({ question, database, namespace, already: vector });
      const rest = vector.filter((group) => !exact.some((match) => match.table === group.table));
      const groups = [...exact, ...rest];
      if (!groups.length) return text(formatEmpty({ question, database: database ?? config.defaultDatabase }));

      const scope = {
        question,
        mode: result.mode,
        database: database ?? config.defaultDatabase,
        note,
        detail,
      };

      if (detail === 'names') {
        return text(
          formatCandidates({
            question,
            candidates: groups.slice(0, config.maxCandidates),
            heading: `# Tables matching: ${question}`,
            reason: 'names and columns only, as requested — no DDL',
            database: scope.database,
          }),
        );
      }

      // A name match settles it, and so does a caller who named the tables.
      const decided =
        exact.length || tables?.length || !config.askWhenUnsure || on_unsure === 'best_effort';
      const verdict = decided
        ? { ask: false, show: exact.length || Math.min(config.maxTables, groups.length) }
        : assess(groups);

      if (verdict.ask) {
        const candidates = groups.slice(0, config.maxCandidates);
        const chosen = await elicitTable(server, { question, candidates });
        if (!chosen) {
          return text(formatCandidates({ question, candidates, reason: verdict.reason, database: scope.database }));
        }
        return text(
          formatSchema({
            ...scope,
            groups: groups.filter((group) => group.name === chosen),
            note: `user chose \`${chosen}\``,
          }),
        );
      }

      return text(
        formatSchema({
          ...scope,
          groups: groups.slice(0, verdict.show),
          extra: groups.slice(verdict.show, verdict.show + config.maxCandidates),
        }),
      );
    }),
  );

  server.registerTool(
    'get_table_schema',
    {
      title: 'Get schema for specific tables',
      description:
        'Fetch the stored DDL for tables by exact name. Use it after the user picks from a candidate list, or when they named the table themselves.',
      inputSchema: {
        tables: z
          .array(z.string().min(1))
          .min(1)
          .max(10)
          .describe('Exact table names, e.g. ["tbl_account", "tbl_order"].'),
        detail: detailArg,
        database: databaseArg,
        namespace: namespaceArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ tables, detail = 'compact', database, namespace }) => {
      const results = await Promise.all(tables.map((table) => fetchTable(table, { database, namespace })));

      const groups = [];
      const missing = [];
      results.forEach((result, index) => {
        if (result.matchedBy !== 'exact-metadata') {
          missing.push(tables[index]);
          return;
        }
        for (const group of groupByTable(result.hits)) {
          if (!groups.some((existing) => existing.name === group.name)) groups.push(group);
        }
      });

      // Nothing matched by name: suggest real names rather than returning the
      // semantic near-misses as though they were the answer.
      if (!groups.length) {
        const inventory = await inventoryWithin(config.inventoryWaitMs);
        const prefer = preferredDatabases(database);
        const suggestions = inventory
          ? [...new Set(missing.flatMap((table) => similarTables(table, inventory, { prefer, limit: 4 })))]
          : [];
        if (suggestions.length || inventory) {
          return text(formatUnknownTables({ missing, suggestions: suggestions.slice(0, 8) }));
        }
        // Inventory still warming — fall back to the semantic candidates.
        const candidates = dedupeByTable(groupByTable(results.flatMap((result) => result.hits)), prefer);
        return text(
          formatCandidates({
            question: missing.join(', '),
            candidates: candidates.slice(0, config.maxCandidates),
            reason: `no table is named ${missing.map((table) => `"${table}"`).join(', ')} — these are the closest records`,
            database: database ?? config.defaultDatabase,
          }),
        );
      }

      // One header for the whole answer instead of one per table.
      return text(
        formatSchema({
          question: tables.map((table) => `\`${table}\``).join(', '),
          groups: dedupeByTable(groups, preferredDatabases(database)).slice(
            0,
            Math.max(config.maxTables, tables.length),
          ),
          mode: 'exact-metadata',
          database: database ?? config.defaultDatabase,
          detail,
          note: missing.length
            ? `not found: ${missing.map((table) => `"${table}"`).join(', ')} — ask the user for the right name, the tables above are the ones that did match`
            : undefined,
        }),
      );
    }),
  );

  server.registerTool(
    'list_tables',
    {
      title: 'List available tables',
      description:
        'Table inventory, grouped by database. Pass `filter` to narrow it — an unfiltered list of a large schema is long. Use when search comes back empty or the user asks what exists.',
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe('Case-insensitive substring, e.g. "payment". Strongly preferred over listing everything.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe(`Max table names to return (default ${config.maxListedTables}).`),
        verbose: z
          .boolean()
          .optional()
          .describe('Include index diagnostics: dimensions, metric, namespaces, metadata fields.'),
        database: databaseArg,
        namespace: namespaceArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ filter, limit, verbose = false, database, namespace }) => {
      const scan = await scanTables({ database, namespace });
      const cap = limit ?? config.maxListedTables;
      const needle = filter?.trim().toLowerCase();

      const matched = scan.databases
        .map((entry) => ({
          database: entry.database,
          tables: needle ? entry.tables.filter((table) => table.toLowerCase().includes(needle)) : entry.tables,
        }))
        .filter((entry) => entry.tables.length);

      const total = matched.reduce((sum, entry) => sum + entry.tables.length, 0);
      const lines = [];

      if (verbose) {
        const [index, namespaces] = await Promise.all([describeIndex(), listNamespaces().catch(() => [])]);
        lines.push(
          `- **index**: \`${index.name}\` · ${index.dimension} dims · ${index.metric} · ${index.vectorType ?? 'dense'}`,
          `- **embedding**: ${index.integrated ? `integrated \`${index.embedModel}\`` : `external \`${config.embedModel}\``}`,
          `- **namespace**: \`${namespace ?? config.namespace ?? ''}\`${namespaces.length ? ` (available: ${namespaces.map((entry) => `${entry.name}=${entry.recordCount}`).join(', ')})` : ''}`,
          `- **records scanned**: ${scan.scanned}${scan.truncated ? ` (stopped at LIST_SCAN_LIMIT=${config.listScanLimit})` : ''}`,
          `- **metadata fields**: ${scan.metadataKeys.join(', ') || 'none found'}`,
          '',
        );
      }

      if (!total) {
        return text(
          [
            `# Tables${needle ? ` matching "${filter}"` : ''}`,
            '',
            ...lines,
            needle
              ? `No table name contains "${filter}". Ask the user for the exact name, or retry with a shorter substring.`
              : database
                ? `No tables found for database \`${database}\`. Call list_tables without a database.`
                : 'No table names found in metadata — check PINECONE_NAMESPACE and TABLE_FIELDS.',
          ].join('\n'),
        );
      }

      lines.unshift(
        `# Tables${needle ? ` matching "${filter}"` : ''} — ${total} across ${matched.length} database(s)`,
        '',
      );

      let shown = 0;
      for (const entry of matched) {
        if (shown >= cap) break;
        const slice = entry.tables.slice(0, cap - shown);
        shown += slice.length;
        lines.push(`**${entry.database}** (${entry.tables.length})`, slice.map((table) => `\`${table}\``).join(', '), '');
      }
      if (total > shown) {
        lines.push(`_${total - shown} more not shown — narrow it with \`filter\`._`);
      }
      lines.push('Call `get_table_schema` with a name for its columns.');

      return text(lines.join('\n'));
    }),
  );
}

/** Builds a fresh, fully-registered server instance. */
export function createServer() {
  const server = new McpServer({ name: 'askdb-mcp', version: '1.1.0' }, { instructions: INSTRUCTIONS });
  registerTools(server);
  return server;
}
