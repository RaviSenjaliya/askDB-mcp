/**
 * Netlify Function — the MCP endpoint.
 *
 * The SDK's Web Standard transport takes a Request and returns a Response,
 * which is exactly a Functions v2 handler, so there is no Node req/res shim
 * here and src/mcp.js is reused untouched.
 *
 * src/http.js stays as the entry point for local runs and long-lived hosts.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from '../../src/mcp.js';

export const config = { path: '/mcp' };

const rpcError = (status, code, message, headers = {}) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

export default async (request) => {
  const authToken = process.env.MCP_AUTH_TOKEN || '';

  // Fail closed, unlike src/http.js. That one defaults to localhost, where an
  // open endpoint is harmless; this URL is on the public internet from the
  // moment it deploys, and it serves the entire schema. A missing token is a
  // misconfiguration, not a "no auth wanted" signal.
  if (!authToken) {
    console.error('[askdb-mcp] MCP_AUTH_TOKEN is not set — refusing to serve.');
    return rpcError(503, -32001, 'Server is not configured: MCP_AUTH_TOKEN is unset.');
  }

  if (request.headers.get('authorization') !== `Bearer ${authToken}`) {
    return rpcError(401, -32001, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
  }

  // Stateless: the SDK throws if one transport handles two requests, and one
  // fresh server per invocation is what the function model gives us anyway.
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  try {
    await server.connect(transport);
    // Neither is closed on the way out: the SSE body can still be streaming
    // when this returns, and the transport ends that stream itself once every
    // response has been written.
    return await transport.handleRequest(request);
  } catch (error) {
    console.error('[askdb-mcp] request failed:', error);
    return rpcError(500, -32603, 'Internal server error');
  }
};
