#!/usr/bin/env node
/** stdio entry point — what Claude Code, Claude Desktop and Cursor launch. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from './config.js';
import { createServer } from './mcp.js';

await createServer().connect(new StdioServerTransport());

// stdout is the protocol channel; diagnostics must go to stderr.
console.error(
  `[askdb-mcp] ready · index=${config.indexName} · namespace=${config.namespace || '(default)'} · db=${config.defaultDatabase || '(all)'}`,
);
