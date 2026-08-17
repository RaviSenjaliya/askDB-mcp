#!/usr/bin/env node
/**
 * stdio entry point — what Claude Code, Claude Desktop and Cursor launch.
 * ChatGPT connectors need HTTP instead: see src/http.js.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from './config.js';
import { createServer } from './mcp.js';

const server = createServer();
await server.connect(new StdioServerTransport());

// stdout is the protocol channel; diagnostics must go to stderr.
console.error(
  `[askdb-mcp] stdio ready · index=${config.indexName} · namespace=${config.namespace || '(default)'} · db=${config.defaultDatabase || '(all)'}`,
);
