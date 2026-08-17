#!/usr/bin/env node
/**
 * End-to-end MCP check: launches src/server.js over stdio as a real client
 * would, lists the tools and calls each one. Run with `npm run smoke`.
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { packageRoot } from '../src/config.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(packageRoot, 'src', 'server.js')],
  stderr: 'pipe',
});
const client = new Client({ name: 'smoke-test', version: '1.0.0' });

const preview = (result, lines = 14) => {
  const body = (result.content ?? []).map((part) => part.text ?? `[${part.type}]`).join('\n');
  const shown = body.split('\n').slice(0, lines).join('\n');
  return `${result.isError ? '  ✗ isError\n' : ''}${shown}${body.split('\n').length > lines ? '\n  …' : ''}`;
};

await client.connect(transport);
console.log('✓ connected\n');

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`);
for (const tool of tools) {
  console.log(`  • ${tool.name} — ${Object.keys(tool.inputSchema?.properties ?? {}).join(', ')}`);
}

const cases = [
  ['list_tables', { database: 'speed_core_live' }],
  ['search_schema', { question: 'total revenue per customer from paid orders last month', top_k: 3, database: 'speed_core_live' }],
  ['get_table_schema', { tables: ['tbl_order'], database: 'speed_core_live' }],
  ['get_table_schema', { tables: ['definitely_not_a_table'] }],
  ['search_schema', { question: 'orders', top_k: 2, tables: ['tbl_order'] }],
];

for (const [name, args] of cases) {
  console.log(`\n--- ${name} ${JSON.stringify(args)}`);
  const result = await client.callTool({ name, arguments: args });
  console.log(preview(result));
}

// Invalid input must come back as an error, not crash the server.
console.log('\n--- validation: search_schema with question too short');
try {
  const result = await client.callTool({ name: 'search_schema', arguments: { question: 'x' } });
  console.log(result.isError ? '  ✓ rejected' : '  ✗ accepted bad input');
  console.log(preview(result, 3));
} catch (error) {
  console.log(`  ✓ rejected: ${error.message.split('\n')[0]}`);
}

await client.close();
console.log('\n✓ smoke test finished');
