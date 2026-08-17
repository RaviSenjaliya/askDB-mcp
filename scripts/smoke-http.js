#!/usr/bin/env node
/**
 * End-to-end check of the HTTP transport: boots src/http.js on a spare port
 * with a bearer token, then drives it with a real MCP client.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { packageRoot } from '../src/config.js';

const port = Number.parseInt(process.env.SMOKE_PORT ?? '', 10) || 3999;
const token = 'smoke-token';
const base = `http://127.0.0.1:${port}`;

// A stale server on this port would answer every check and make the results
// meaningless, so refuse to run rather than test the wrong process.
try {
  const existing = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
  if (existing.ok) {
    console.error(`✗ something is already listening on ${base} — stop it, or set SMOKE_PORT to a free port.`);
    process.exit(1);
  }
} catch {
  // Nothing there: good.
}

const child = spawn(process.execPath, [path.join(packageRoot, 'src', 'http.js')], {
  env: { ...process.env, PORT: String(port), MCP_AUTH_TOKEN: token },
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.on('exit', (code) => {
  if (code) console.error(`✗ server exited early with code ${code}`);
});

const waitForHealth = async () => {
  const started = Date.now();
  // Generous: a cold ESM import graph on Windows can take several seconds.
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return { ...(await response.json()), bootMs: Date.now() - started };
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server never became healthy within 30s');
};

try {
  console.log('health:', JSON.stringify(await waitForHealth()));

  // Unauthorized request must be rejected.
  const denied = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  console.log(`no-token request -> ${denied.status} ${denied.status === 401 ? '✓ rejected' : '✗ EXPECTED 401'}`);

  const client = new Client({ name: 'smoke-http', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  console.log('✓ connected over streamable http');

  const { tools } = await client.listTools();
  console.log(`tools: ${tools.map((tool) => tool.name).join(', ')}`);

  const result = await client.callTool({
    name: 'search_schema',
    arguments: { question: 'revenue per customer from orders', top_k: 2 },
  });
  const body = result.content.map((part) => part.text).join('\n');
  const matched = [...body.matchAll(/^### \d+\. `(.+?)`/gm)].map((match) => match[1]);
  console.log(`search_schema -> ${result.isError ? 'ERROR' : matched.join(', ')}`);

  await client.close();
  console.log('\n✓ http smoke test finished');
} finally {
  child.kill();
}
