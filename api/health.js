/**
 * Vercel Function — unauthenticated health check, served at /health.
 *
 * The serverless stand-in for reading a startup log: it reports whether the
 * required environment variables actually landed in this deployment. Presence
 * only — it never echoes a value.
 */
import { config } from '../src/config.js';

export function GET() {
  const env = {
    PINECONE_API_KEY: Boolean(config.apiKey),
    MCP_AUTH_TOKEN: Boolean(process.env.MCP_AUTH_TOKEN),
  };
  const ready = Object.values(env).every(Boolean);

  return new Response(
    JSON.stringify({
      status: ready ? 'ok' : 'misconfigured',
      index: config.indexName,
      namespace: config.namespace || '(default)',
      database: config.defaultDatabase || '(all)',
      env,
    }),
    {
      status: ready ? 200 : 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    },
  );
}
