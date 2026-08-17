#!/usr/bin/env node
/**
 * Streamable HTTP entry point, for clients that cannot spawn a local process —
 * ChatGPT connectors, or Claude Code over a tunnel.
 *
 * Stateless: a fresh server + transport per request, so there is no session
 * state to lose behind a load balancer.
 */
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { createServer } from './mcp.js';

const port = Number.parseInt(process.env.PORT ?? '', 10) || 3000;
const host = process.env.HTTP_HOST || '127.0.0.1';
const endpoint = process.env.HTTP_PATH || '/mcp';
/** Set MCP_AUTH_TOKEN before exposing this beyond localhost. */
const authToken = process.env.MCP_AUTH_TOKEN || '';

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const rpcError = (res, status, code, message) =>
  json(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  // Unauthenticated on purpose: load balancers and keep-alive pingers hit this,
  // and a request here is what wakes a sleeping instance. Reveals no secrets.
  if (url.pathname === '/health') {
    return json(res, 200, {
      status: 'ok',
      index: config.indexName,
      // The field that tells you whether keep-alive is working: if uptime keeps
      // resetting to near-zero, the host is sleeping between pings.
      uptimeSeconds: Math.round(process.uptime()),
    });
  }

  if (url.pathname !== endpoint) {
    return rpcError(res, 404, -32601, `Not found. The MCP endpoint is ${endpoint}`);
  }

  if (authToken && req.headers.authorization !== `Bearer ${authToken}`) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return rpcError(res, 401, -32001, 'Unauthorized');
  }

  // Stateless mode has no standalone SSE stream to attach to.
  if (req.method === 'GET' || req.method === 'DELETE') {
    res.writeHead(405, { Allow: 'POST' });
    return res.end();
  }

  if (req.method !== 'POST') {
    return rpcError(res, 405, -32600, 'Method not allowed');
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return rpcError(res, 400, -32700, error.message);
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error('[askdb-mcp] request failed:', error);
    if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error');
  }
});

httpServer.listen(port, host, () => {
  console.error(
    `[askdb-mcp] http ready on http://${host}:${port}${endpoint} · index=${config.indexName} · auth=${authToken ? 'bearer' : 'NONE'}`,
  );
  if (!authToken && host !== '127.0.0.1' && host !== 'localhost') {
    console.error('[askdb-mcp] WARNING: listening beyond localhost with no MCP_AUTH_TOKEN set.');
  }
});
