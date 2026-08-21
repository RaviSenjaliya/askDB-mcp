#!/usr/bin/env node
/** stdio entry point — what Claude Code, Claude Desktop and Cursor launch. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from './config.js';
import { createServer } from './mcp.js';
import { warmup } from './pinecone.js';

await createServer().connect(new StdioServerTransport());

// Not awaited: the handshake is already done, and this pays the SDK import and
// the table scan now so the first question does not.
warmup();

// stdout is the protocol channel; diagnostics must go to stderr.
console.error(
  `[askdb-mcp] ready · index=${config.indexName} · namespace=${config.namespace || '(default)'} · db=${config.defaultDatabase || '(all)'}`,
);
