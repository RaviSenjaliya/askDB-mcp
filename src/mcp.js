import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { config } from './config.js';
import { describeIndex, fetchTable, listNamespaces, scanTables, searchSchema } from './pinecone.js';
import { formatSchemaContext } from './format.js';

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

const INSTRUCTIONS = [
  'askDB provides the database schema for this project, retrieved semantically from a vector index.',
  'Before writing ANY SQL, call `search_schema` with the user question in natural language.',
  'Use `list_tables` for the full inventory and `get_table_schema` when you already know the table name.',
  'Only reference tables and columns these tools returned; never invent names.',
].join(' ');

const databaseArg = z
  .string()
  .optional()
  .describe(
    `Restrict to one database/schema${config.defaultDatabase ? ` (default \`${config.defaultDatabase}\`)` : ' — omit to search all of them'}.`,
  );
const namespaceArg = z.string().optional().describe('Pinecone namespace override.');

function registerTools(server) {
  server.registerTool(
    'search_schema',
    {
      title: 'Search database schema',
      description:
        'Semantic search over the database schema stored in Pinecone. Call this FIRST for any text-to-SQL request: pass the user question verbatim and you get back the relevant tables, columns, types and relationships to write the query against.',
      inputSchema: {
        question: z
          .string()
          .min(3)
          .describe(
            'The natural-language data question, e.g. "top 10 accounts by transaction volume last month".',
          ),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(config.maxTopK)
          .optional()
          .describe(`How many schema chunks to retrieve (default ${config.defaultTopK}).`),
        tables: z
          .array(z.string())
          .optional()
          .describe('Restrict the search to these table names, when you already know them.'),
        database: databaseArg,
        namespace: namespaceArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ question, top_k, tables, database, namespace }) => {
      const topK = top_k ?? config.defaultTopK;
      let result;
      let note;
      try {
        result = await searchSchema({ query: question, topK, tables, database, namespace });
      } catch (error) {
        if (!tables?.length) throw error;
        // The metadata filter referenced fields this index does not have.
        note = `table filter ${JSON.stringify(tables)} could not be applied — showing unfiltered matches`;
        result = await searchSchema({ query: question, topK, database, namespace });
      }

      return text(
        formatSchemaContext({
          question,
          hits: result.hits,
          mode: result.mode,
          namespace: namespace ?? config.namespace,
          database: database ?? config.defaultDatabase,
          note,
        }),
      );
    }),
  );

  server.registerTool(
    'get_table_schema',
    {
      title: 'Get schema for specific tables',
      description:
        'Fetch the full stored DDL for one or more tables by exact name. Use after search_schema when you need every column of a table, or when the user named the table.',
      inputSchema: {
        tables: z
          .array(z.string().min(1))
          .min(1)
          .describe('Exact table names, e.g. ["tbl_account", "tbl_order"].'),
        database: databaseArg,
        namespace: namespaceArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ tables, database, namespace }) => {
      const sections = [];
      for (const table of tables) {
        const { hits, matchedBy } = await fetchTable(table, { database, namespace });
        sections.push(
          formatSchemaContext({
            question: `full schema of "${table}"`,
            hits,
            mode: matchedBy,
            namespace: namespace ?? config.namespace,
            database: database ?? config.defaultDatabase,
            note:
              matchedBy === 'semantic-fallback'
                ? `no exact match for "${table}" — these are the closest records, verify the name before using it`
                : undefined,
          }),
        );
      }
      return text(sections.join('\n\n---\n\n'));
    }),
  );

  server.registerTool(
    'list_tables',
    {
      title: 'List available tables',
      description:
        'Inventory of every table in the schema index, grouped by database, plus the index configuration. Use it to orient yourself, or when search_schema comes back empty.',
      inputSchema: { database: databaseArg, namespace: namespaceArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ database, namespace }) => {
      const [index, scan, namespaces] = await Promise.all([
        describeIndex(),
        scanTables({ database, namespace }),
        listNamespaces().catch(() => []),
      ]);

      const total = scan.databases.reduce((sum, entry) => sum + entry.tables.length, 0);
      const lines = [
        '# Database schema index',
        '',
        `- **index**: \`${index.name}\` · ${index.dimension} dims · ${index.metric} · ${index.vectorType ?? 'dense'}`,
        `- **embedding**: ${index.integrated ? `integrated \`${index.embedModel}\`` : `external \`${config.embedModel}\``}`,
        `- **namespace**: \`${namespace ?? config.namespace ?? ''}\`${namespaces.length ? ` (available: ${namespaces.map((entry) => `${entry.name}=${entry.recordCount}`).join(', ')})` : ''}`,
        `- **records scanned**: ${scan.scanned}${scan.truncated ? ` (stopped at LIST_SCAN_LIMIT=${config.listScanLimit})` : ''}`,
        `- **metadata fields**: ${scan.metadataKeys.join(', ') || 'none found'}`,
        `- **SQL dialect**: ${config.sqlDialect}`,
        '',
      ];

      if (total) {
        lines.push(`## Tables (${total} across ${scan.databases.length} database(s))`, '');
        for (const entry of scan.databases) {
          lines.push(`### ${entry.database} — ${entry.tables.length} tables`, '');
          lines.push(entry.tables.map((table) => `\`${table}\``).join(', '), '');
        }
        lines.push(
          'Call `get_table_schema` with a table name (and `database` when the name repeats) for its columns.',
        );
      } else {
        lines.push(
          '## Tables',
          '',
          database
            ? `No tables found for database \`${database}\`. Call list_tables without a database to see what exists.`
            : 'No table names found in metadata.',
          scan.metadataKeys.length
            ? `Records use these metadata fields: ${scan.metadataKeys.join(', ')} — set TABLE_FIELDS/DB_FIELDS in .env accordingly.`
            : 'The index returned no records for this namespace — check PINECONE_NAMESPACE.',
        );
      }

      return text(lines.join('\n'));
    }),
  );
}

/** Builds a fresh, fully-registered server instance. */
export function createServer() {
  const server = new McpServer(
    { name: 'askdb-mcp', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server);
  return server;
}
