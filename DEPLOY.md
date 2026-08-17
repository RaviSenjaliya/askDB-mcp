# Hosting askDB MCP on Netlify

This deploys askDB as two Netlify Functions, so clients that cannot spawn a local process — ChatGPT connectors, Claude Code on someone else's laptop — can reach it over HTTPS. Your Pinecone key lives in one place instead of on everyone's machine, and each person gets a URL plus a token rather than a repo to clone.

```
Claude Code / ChatGPT ──HTTPS + Bearer──► Netlify Function ──► Pinecone
```

| Route | File | Auth |
| --- | --- | --- |
| `POST /mcp` | [netlify/functions/mcp.mjs](netlify/functions/mcp.mjs) | Bearer token, required |
| `GET /health` | [netlify/functions/health.mjs](netlify/functions/health.mjs) | none |

**Why this works without a rewrite:** the MCP SDK ships `WebStandardStreamableHTTPServerTransport`, whose `handleRequest(Request) → Response` signature *is* the Netlify Functions v2 handler shape. There's no Node `req`/`res` shim, and [src/mcp.js](src/mcp.js) — the actual tool logic — is imported unchanged. [src/http.js](src/http.js) still exists for local runs and long-lived hosts.

The transport runs stateless (`sessionIdGenerator: undefined`), which is what makes serverless viable at all: no session state has to survive between invocations.

---

## 1. Push the repo

```bash
git add netlify.toml netlify/ public/ .node-version DEPLOY.md README.md SETUP.md src/http.js
git commit -m "feat: deploy as netlify functions"
git push
```

`.gitignore` already excludes `.env`, so no key is committed. Confirm with `git status` before pushing.

## 2. Create the site

Netlify → **Add new site** → **Import an existing project** → pick the repo.

[netlify.toml](netlify.toml) supplies the build settings, so leave the detected values alone:

| Field | Value |
| --- | --- |
| Build command | `npm install` |
| Publish directory | `public` |
| Functions directory | `netlify/functions` |

Routing comes from the `config.path` export inside each function — no redirect rules needed.

## 3. Set environment variables

Site configuration → **Environment variables**:

| Key | Value |
| --- | --- |
| `PINECONE_API_KEY` | your key from [app.pinecone.io](https://app.pinecone.io) → API Keys |
| `MCP_AUTH_TOKEN` | a long random string — generate it, see below |
| `PINECONE_INDEX` | `ask-db` |
| `EMBED_MODEL` | `multilingual-e5-large` |

Generate the token rather than inventing one. Anyone holding URL + token can read your whole schema:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Optional, if you need them: `PINECONE_NAMESPACE`, `DEFAULT_DATABASE`, `SQL_DIALECT`, `RERANK_MODEL`, `TOP_K`.

Redeploy after adding variables — Netlify bakes them in at build time.

## 4. Verify

```bash
curl https://<your-site>.netlify.app/health
```

```json
{"status":"ok","index":"ask-db","namespace":"(default)","pineconeKey":"set","auth":"bearer"}
```

Both `pineconeKey: "set"` and `auth: "bearer"` must appear. On a serverless host there's no startup log to read, so this endpoint is how you confirm the variables landed — it reports presence only and never echoes a value.

If `auth` says `MISSING`, `/mcp` returns **503 and serves nothing**. That's deliberate: this URL is public from the moment it deploys, so an unset token is treated as a misconfiguration rather than as "no auth wanted."

Then check the endpoint rejects and accepts correctly:

```bash
# no token
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<your-site>.netlify.app/mcp \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# 401

# with token
curl -X POST https://<your-site>.netlify.app/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The `Accept` header is required — Streamable HTTP rejects requests that don't accept both types. You should get `search_schema`, `get_table_schema`, `list_tables` back as an SSE frame.

## 5. Connect clients

**Claude Code** (CLI, desktop and IDE extensions share this config):

```bash
claude mcp add --transport http askdb https://<your-site>.netlify.app/mcp \
  --scope user \
  --header "Authorization: Bearer <token>"
```

Check with `claude mcp list` → `askdb: ... ✓ Connected`.

**ChatGPT** — Settings → Connectors → Developer mode → same URL, `Authorization: Bearer <token>` header.

**Cursor / Claude Desktop** — MCP settings, HTTP transport, same URL and header.

This is Route A in [SETUP.md](SETUP.md) — that's the page to send teammates.

---

## Things that will bite you

**Cold invocations are slow — but they fit.** Measured locally against the real index:

| | Time |
| --- | --- |
| Warm call (`search_schema`) | ~0.8s |
| `tools/list` | ~40ms |
| Cold call | 8–32s |

The cold path breaks down as ~5s loading the Pinecone SDK plus ~3s of first-time network round trips (`describeIndex`, then the first data-plane call). Netlify bundles with esbuild into a single file, which removes most of that module-loading term, so deployed cold calls should land well below the local figure.

Netlify's synchronous timeout is **60 seconds and not configurable**, so even the worst local number has margin — but this is the one limit worth watching if you ever add slower work to a tool. Containers stay warm between invocations under steady use, so most real calls are the 0.8s case.

**The publish directory is not cosmetic.** `publish = "public"` in [netlify.toml](netlify.toml) exists so Netlify serves only [public/index.html](public/index.html). Point it at the repo root and you publish `src/`, the README and the rest of the tree as a public static site.

**Rotating the token.** Change `MCP_AUTH_TOKEN` and redeploy; every existing client breaks until re-added with the new value. There's one shared token, not per-user ones — the function compares against a single string. For per-person revocation you'd need a gateway in front, or one site per team.

**The URL is your whole schema.** Anyone with URL + token can read every table definition in the index. It's DDL, not data — askDB never connects to your database — but treat it as internal. [public/index.html](public/index.html) is `noindex`, though that's a hint to crawlers, not a control.

**Function logs live per-function.** Site → Logs → Functions, then pick `mcp` or `health`. There's no single process log like a container host gives you.

## Local development

```bash
npx netlify dev     # serves the functions at http://localhost:8888
```

That runs the real function handlers with your `.env` loaded, so `/mcp` and `/health` behave as deployed. For the plain Node server instead — no Netlify CLI, no functions layer:

```bash
npm run start:http  # http://127.0.0.1:3000/mcp
npm run smoke:http  # drives it with a real MCP client
```

## Deploying elsewhere

Nothing here is Netlify-specific except [netlify.toml](netlify.toml) and the two `config.path` exports.

- **Cloudflare Workers / Deno / Bun** — reuse [netlify/functions/mcp.mjs](netlify/functions/mcp.mjs) nearly verbatim; the Web Standard transport is built for exactly these runtimes.
- **A container or VM** (Render, Fly, a box you own) — use [src/http.js](src/http.js) instead: run `npm run start:http`, set `HTTP_HOST=0.0.0.0`, let the platform supply `PORT`, terminate TLS in front, and set `MCP_AUTH_TOKEN`.

Either way the transport is stateless, so it scales horizontally with no sticky sessions.
