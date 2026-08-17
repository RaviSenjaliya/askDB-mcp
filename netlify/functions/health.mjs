/**
 * Netlify Function — unauthenticated liveness and configuration check.
 *
 * On a serverless host there is no startup log to read, so this replaces the
 * `auth=bearer` line src/http.js prints: it reports whether the required env
 * vars landed, without ever echoing their values.
 */
// Aliased: `config` is reserved below for Netlify's route declaration.
import { config as askdb } from '../../src/config.js';

export const config = { path: '/health' };

export default async () =>
  new Response(
    JSON.stringify({
      status: 'ok',
      index: askdb.indexName,
      namespace: askdb.namespace || '(default)',
      // Presence only — never the values themselves.
      pineconeKey: askdb.apiKey ? 'set' : 'MISSING',
      auth: process.env.MCP_AUTH_TOKEN ? 'bearer' : 'MISSING — /mcp will refuse to serve',
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
