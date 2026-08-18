# askDB MCP

An MCP server that turns natural-language data questions into the **schema context** an LLM needs to write SQL. It does not connect to your database and it does not generate SQL itself — it retrieves the right table definitions from your Pinecone index and hands them to whichever model is asking.

```
user question
   │
   ▼
Claude Code / ChatGPT ──calls──► askDB MCP ──semantic search──► Pinecone (ask-db)
   │                                  │
   │      relevant DDL + guardrails ◄─┘
   ▼
generated SQL
```

Runs two ways from the same code: locally over **stdio**, or hosted on **Vercel** over HTTP.

## Tools

| Tool               | When the model uses it                       | Input                                        |
| ------------------ | -------------------------------------------- | -------------------------------------------- |
| `search_schema`    | First call for any text-to-SQL request       | `question`, `top_k?`, `tables?`, `database?` |
| `get_table_schema` | Needs every column of a known table          | `tables[]`, `database?`                      |
| `list_tables`      | Orientation, or when search comes back empty | `database?`                                  |

Every response embeds instructions telling the model to use only the returned tables and columns, so it does not invent names.

## Run it locally

```bash
npm install
cp .env.example .env      # then set PINECONE_API_KEY
```

### Claude Code

The CLI, the desktop app and the IDE extensions share one config, so this registers the server for all three:

```powershell
# from the repo root — records an absolute path, so it works in any folder
claude mcp add askdb --scope user -- node "$PWD\src\server.js"
```

Check it with `claude mcp list` (`askdb: ... ✓ Connected`), then restart the desktop app or IDE window — MCP servers load at startup.

User scope is deliberate: the point is to ask database questions while working in your *other* repos. A project-scoped `.mcp.json` would only resolve when Claude Code is started at this repo's root.

### Claude Desktop / Cursor

Add to `claude_desktop_config.json` (or Cursor's MCP settings):

```json
{
  "mcpServers": {
    "askdb": {
      "command": "node",
      "args": ["D:\\working-directory\\AI\\askDB-mcp\\src\\server.js"]
    }
  }
}
```

Credentials come from `.env` next to the server, so no keys go in the client config.

---

## Host it on Vercel

Two functions, no build step. [api/mcp.js](api/mcp.js) is the MCP endpoint; [api/health.js](api/health.js) tells you whether the deployment is configured. Both reuse [src/mcp.js](src/mcp.js) unchanged — the MCP SDK's `WebStandardStreamableHTTPServerTransport` takes a `Request` and returns a `Response`, which is exactly Vercel's Web Handler signature, so there's no shim in between.

### 1. Generate an auth token

`/mcp` serves your entire schema to anyone who can reach the URL, so it **fails closed**: with no `MCP_AUTH_TOKEN` set it returns `503` rather than serving anything.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep this out of git — it goes in Vercel's environment variables, nowhere else.

### 2. Deploy

**From the dashboard:** push the repo to GitHub, then [vercel.com/new](https://vercel.com/new) → import it. Framework Preset **Other**, no build command, no output directory — Vercel picks up `api/` on its own.

**Or from the CLI:**

```bash
npx vercel login
npx vercel link
npx vercel deploy --prod
```

### 3. Set environment variables

Project Settings → Environment Variables, scoped to **Production** (add Preview too if you want preview deploys to work):

| Variable            | Value                                          |
| ------------------- | ---------------------------------------------- |
| `PINECONE_API_KEY`  | your Pinecone key                              |
| `MCP_AUTH_TOKEN`    | the token from step 1                          |
| `DEFAULT_DATABASE`  | optional, e.g. `speed_core_live` — see below   |
| `SQL_DIALECT`       | optional, e.g. `MySql`                         |

Or via CLI: `npx vercel env add PINECONE_API_KEY production`

**Redeploy after adding them** — environment variables are baked in at deploy time, so an existing deployment won't pick them up.

### 4. Turn off Deployment Protection

Settings → **Deployment Protection**. If Vercel Authentication is on for production, every request to `/mcp` gets bounced to an SSO login page and no MCP client can connect. Turn it off for production (your bearer token is the access control), or issue a Protection Bypass token and send it as well.

This is the single most common reason a deploy that looks fine returns HTML instead of JSON.

### 5. Verify

```bash
curl https://<your-app>.vercel.app/health
```

```json
{ "status": "ok", "index": "ask-db", "env": { "PINECONE_API_KEY": true, "MCP_AUTH_TOKEN": true } }
```

`env` reports presence only, never values. A `503` with `"status": "misconfigured"` means a variable is missing or you haven't redeployed since adding it.

Then the endpoint itself:

```bash
curl -X POST https://<your-app>.vercel.app/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should get an SSE frame listing the three tools. `401` means the token doesn't match; HTML means Deployment Protection is still on.

### Local testing

```bash
npx vercel dev      # serves /mcp and /health on localhost:3000, reading .env
```

### Connect a client to the hosted server

**Claude Code:**

```bash
claude mcp add --transport http askdb https://<your-app>.vercel.app/mcp \
  --scope user \
  --header "Authorization: Bearer <token>"
```

**Claude Desktop / Cursor** — neither speaks remote MCP natively, so bridge with `mcp-remote`:

```json
{
  "mcpServers": {
    "askdb": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://<your-app>.vercel.app/mcp",
        "--header", "Authorization: Bearer <token>"
      ]
    }
  }
}
```

**ChatGPT:** add a connector pointing at `https://<your-app>.vercel.app/mcp` with an `Authorization: Bearer <token>` header.

Teammates need nothing installed — just the URL and the token.

---

## Configuration

All optional except the API key. See [.env.example](.env.example) — the same names work as Vercel environment variables.

| Variable                                     | Default                 | Notes                                      |
| -------------------------------------------- | ----------------------- | ------------------------------------------ |
| `PINECONE_API_KEY`                           | —                       | Required                                   |
| `MCP_AUTH_TOKEN`                             | —                       | Required when hosted; unused over stdio    |
| `PINECONE_INDEX`                             | `ask-db`                |                                            |
| `PINECONE_NAMESPACE`                         | _(default ns)_          |                                            |
| `TOP_K` / `MAX_TOP_K`                        | `8` / `30`              | Schema chunks per search                   |
| `EMBED_MODEL`                                | `multilingual-e5-large` | **Must match the model you upserted with** |
| `DEFAULT_DATABASE`                           | _(all)_                 | Scope every lookup to one database         |
| `SQL_DIALECT`                                | `ANSI SQL`              | Passed to the model as a hint              |
| `TEXT_FIELDS` / `TABLE_FIELDS` / `DB_FIELDS` | _(auto-detected)_       | Candidate metadata keys, tried in order    |
| `LIST_SCAN_LIMIT`                            | `1000`                  | Cap on `list_tables` scanning              |

The server samples the index on first use to detect which metadata fields your records use and whether the index has integrated embedding, so the defaults usually work unchanged.

## Three things worth knowing

**The embedding model must match.** If `EMBED_MODEL` is not the model the schema was upserted with, every score collapses to near-zero and results are noise — the vectors are effectively random relative to each other. You'll see this as unrelated tables coming back with scores around `0.01` instead of `0.8`. This index was built with `multilingual-e5-large`. (Irrelevant if the index has integrated embedding — `list_tables` reports which.)

**Set `DEFAULT_DATABASE` if your index holds several environments.** When the same schema exists as `*_live` and `*_test`, an unscoped search returns both copies of every table, burning half the `top_k` slots on duplicates and letting the model mix environments in one query.

**Cold starts are slow on purpose.** The Pinecone SDK costs ~6s to import, so [src/pinecone.js](src/pinecone.js) loads it lazily on first use rather than at startup — that keeps the stdio handshake fast. Hosted, it means the first request after a scale-to-zero pays that cost inside the request, which is why `api/mcp.js` is given a 60s `maxDuration` in [vercel.json](vercel.json). Warm invocations reuse the cached client.

## Layout

| File                               | Role                                               |
| ---------------------------------- | -------------------------------------------------- |
| [src/server.js](src/server.js)     | stdio entry point                                  |
| [src/mcp.js](src/mcp.js)           | Tool definitions — the MCP surface                 |
| [src/pinecone.js](src/pinecone.js) | Retrieval: search, exact fetch, field detection    |
| [src/format.js](src/format.js)     | Renders hits into the schema block the model reads |
| [src/config.js](src/config.js)     | Env loading and defaults                           |
| [api/mcp.js](api/mcp.js)           | Hosted MCP endpoint — `/mcp`, bearer auth          |
| [api/health.js](api/health.js)     | Hosted config check — `/health`, unauthenticated   |
| [vercel.json](vercel.json)         | Routing and function duration                      |
