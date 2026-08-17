# askDB MCP

An MCP server that turns natural-language data questions into the **schema context** an LLM needs to write SQL. It does not connect to your database and it does not generate SQL itself — it retrieves the right table definitions from your Pinecone index and hands them to whichever model is asking (Claude Code, Claude Desktop, ChatGPT, Cursor).

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

## Tools

| Tool               | When the model uses it                       | Input                                        |
| ------------------ | -------------------------------------------- | -------------------------------------------- |
| `search_schema`    | First call for any text-to-SQL request       | `question`, `top_k?`, `tables?`, `database?` |
| `get_table_schema` | Needs every column of a known table          | `tables[]`, `database?`                      |
| `list_tables`      | Orientation, or when search comes back empty | `database?`                                  |

Every response embeds instructions telling the model to use only the returned tables and columns, so it does not invent names.

## Setup

```bash
npm install
npm run setup             # creates .env from the template
#                          → then put your PINECONE_API_KEY in .env
npm run doctor            # verify connection, field mapping and retrieval quality
```

Sharing this with someone else? Send them [SETUP.md](SETUP.md) — it covers both running it locally and connecting to a hosted instance.

`npm run doctor` is the important step. It prints the index config, the metadata fields your records actually use, and a sample search — so you can confirm the server is reading the right fields before you wire it into a client.

```bash
npm run doctor       # connectivity + retrieval sanity check
npm run smoke        # drive the stdio server with a real MCP client
npm run smoke:http   # same over Streamable HTTP, with bearer auth
```

## Connect a client

### Claude Code

The CLI, the desktop app and the IDE extensions all share one config, so this registers the server for all three:

```powershell
# from the repo root — records an absolute path, so it works in any folder
claude mcp add askdb --scope user -- node "$PWD\src\server.js"
```

Check it with `claude mcp list` (`askdb: ... ✓ Connected`), then restart the desktop app or IDE window — MCP servers load at startup.

User scope is deliberate: the point is to ask database questions while working in your *other* repos. A project-scoped `.mcp.json` would only resolve when Claude Code is started at this repo's root, and defining `askdb` in both scopes makes Claude Code warn about the duplicate.

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

### ChatGPT

ChatGPT connectors cannot spawn a local process — they only speak **remote MCP over HTTP**. Run the HTTP transport and expose it:

```bash
# set MCP_AUTH_TOKEN first: this endpoint serves your whole schema
MCP_AUTH_TOKEN=some-long-random-string npm run start:http
```

Then point the connector at `https://<your-host>/mcp` with an `Authorization: Bearer <token>` header. For a quick trial, tunnel it (`cloudflared tunnel --url http://localhost:3000`); for anything lasting, host it properly — [DEPLOY.md](DEPLOY.md) covers Netlify end to end. `GET /health` is unauthenticated for load-balancer checks; `/mcp` requires the bearer token whenever `MCP_AUTH_TOKEN` is set.

The HTTP transport is stateless — one server instance per request — so it scales behind a load balancer without sticky sessions.

## Hosting

Deployed as two Netlify Functions — [netlify.toml](netlify.toml) carries the build settings, so importing the repo and setting `PINECONE_API_KEY` + `MCP_AUTH_TOKEN` is the whole job. Step-by-step: **[DEPLOY.md](DEPLOY.md)**.

This works without a transport rewrite because the MCP SDK's `WebStandardStreamableHTTPServerTransport` takes a `Request` and returns a `Response` — the Netlify Functions v2 signature — so [netlify/functions/mcp.mjs](netlify/functions/mcp.mjs) imports [src/mcp.js](src/mcp.js) unchanged. The same file drops onto Cloudflare Workers, Deno or Bun; [src/http.js](src/http.js) covers containers and VMs.

`GET /health` needs no token and reports whether the required env vars landed (presence only, never values) — the serverless stand-in for reading a startup log. `/mcp` **fails closed**: with no `MCP_AUTH_TOKEN` set it returns 503 rather than serving your schema to the internet.

Once it's up, teammates need nothing installed — just the URL and a token ([SETUP.md](SETUP.md), Route A).

## Configuration

All optional except the API key. See [.env.example](.env.example).

| Variable                                     | Default                 | Notes                                              |
| -------------------------------------------- | ----------------------- | -------------------------------------------------- |
| `PINECONE_API_KEY`                           | —                       | Required                                           |
| `PINECONE_INDEX`                             | `ask-db`                |                                                    |
| `PINECONE_NAMESPACE`                         | _(default ns)_          |                                                    |
| `TOP_K`                                      | `8`                     | Schema chunks per search                           |
| `EMBED_MODEL`                                | `multilingual-e5-large` | **Must match the model you upserted with**         |
| `RERANK_MODEL`                               | _(off)_                 | e.g. `bge-reranker-v2-m3`; measure before enabling |
| `DEFAULT_DATABASE`                           | _(all)_                 | Scope every lookup to one database                 |
| `SQL_DIALECT`                                | `ANSI SQL`              | Passed to the model as a hint                      |
| `TEXT_FIELDS` / `TABLE_FIELDS` / `DB_FIELDS` | see `.env.example`      | Candidate metadata keys, tried in order            |
| `LIST_SCAN_LIMIT`                            | `1000`                  | Cap on `list_tables` scanning                      |

The server auto-detects which metadata fields your records use and whether the index has integrated embedding, so the defaults usually work unchanged.

## Two things worth knowing

**The embedding model must match.** If `EMBED_MODEL` is not the model the schema was upserted with, every score collapses to near-zero and results are noise — the vectors are effectively random relative to each other. `npm run doctor` will show this as unrelated tables coming back with scores around `0.01` instead of `0.8`. This index was built with `multilingual-e5-large`.

**Set `DEFAULT_DATABASE` if your index holds several environments.** When the same schema exists as `*_live` and `*_test`, an unscoped search returns both copies of every table, burning half the `top_k` slots on duplicates and letting the model mix environments in one query.

## Layout

| File                                   | Role                                                    |
| -------------------------------------- | ------------------------------------------------------- |
| [src/mcp.js](src/mcp.js)               | Tool definitions — the MCP surface                      |
| [src/pinecone.js](src/pinecone.js)     | Retrieval: search, exact fetch, field detection, rerank |
| [src/format.js](src/format.js)         | Renders hits into the schema block the model reads      |
| [src/server.js](src/server.js)         | stdio entry point                                       |
| [src/http.js](src/http.js)             | Streamable HTTP entry point                             |
| [src/config.js](src/config.js)         | Env loading and defaults                                |
| [scripts/doctor.js](scripts/doctor.js) | Connectivity and retrieval diagnostics                  |
| [netlify/functions/](netlify/functions/) | Serverless entry points — `/mcp` and `/health`        |
| [netlify.toml](netlify.toml)           | Netlify build and routing config                        |
| [DEPLOY.md](DEPLOY.md)                 | Hosting guide                                           |
