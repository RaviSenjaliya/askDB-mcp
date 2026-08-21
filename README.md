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

| Tool               | When the model uses it                       | Input                                                                       |
| ------------------ | -------------------------------------------- | --------------------------------------------------------------------------- |
| `search_schema`    | First call for any text-to-SQL request       | `question`, `tables?`, `top_k?`, `detail?`, `on_unsure?`, `database?`        |
| `get_table_schema` | The table is known — usually the user said so | `tables[]`, `detail?`, `database?`                                          |
| `list_tables`      | Orientation, or when search comes back empty | `filter?`, `limit?`, `verbose?`, `database?`                                 |

The rules that keep the model from inventing table names are sent once, in the server's MCP `instructions`, rather than repeated inside every tool result.

## It asks instead of guessing

The schema index cannot always tell which table a question means. This one is honest about that.

Retrieval is scored for *shape*, not absolute confidence: `0.91, 0.74, 0.70` has an obvious cliff after the first table, while `0.831, 0.830, 0.829, 0.828` is a flat line and means the embedding could not tell those tables apart. On a flat ranking `search_schema` returns a numbered shortlist with each table's columns instead of a wall of DDL, and the calling model is told to put the choice to you:

```
# Ambiguous: 5 tables could answer "give me the mapping details"
_the top 5 tables scored within 0.4% of each other — retrieval could not separate them_

**Do not guess and do not write SQL yet.** Show this list to the user, ask which
table(s) they mean, then call `get_table_schema` with the names they pick.

1. `speed_core_live.tbl_app_category_mapping` (also in speed_core_test) · 0.814 — id, created, modified, account_id …
2. `speed_node.tbl_tron_address_token_mapping` · 0.813 — id, chain_id, address, token_address, balance …
```

That shortlist costs ~300 tokens; the eight full table definitions it replaces cost ~1,400. Where the client supports MCP elicitation the server prompts you directly instead, skipping the round trip through the model. `on_unsure: "best_effort"` forces an answer anyway, and `ASK_WHEN_UNSURE=false` turns the behaviour off entirely.

Names get the same treatment. `get_table_schema(["payments"])` does not silently return whatever was nearest in vector space — it answers with real names to choose from, for ~75 tokens:

```
No table named `payments` in the index.

Closest real names:
- `speed_core_live.tbl_payment`
- `speed_core_live.tbl_payment_link`
```

## Where the tokens went

Measured against this repo's own index (~486 tables across 5 databases), same questions, same retrieval:

| Call                                        | Before      | After     |
| ------------------------------------------- | ----------- | --------- |
| `search_schema` × 6 realistic questions     | 9,081 tok   | 2,221 tok |
| `get_table_schema` with 2 tables            | 1,712 tok   | 679 tok   |
| `list_tables`, whole schema                 | ~3,000 tok  | 822 tok   |
| `list_tables` with `filter: "payment"`      | —           | 338 tok   |

Four things changed:

- **One entry per table.** A table split across several chunks was rendered several times over, header and all.
- **No metadata dump.** Every hit used to print all of its metadata fields alongside the DDL. `detail: "full"` still does.
- **Standing instructions moved to the handshake.** The five-step "how to use this" preamble was previously repeated in every result — and once per table in `get_table_schema`.
- **Budgets.** At most `MAX_TABLES` tables per answer, `MAX_CHARS_PER_TABLE` each, `MAX_RESPONSE_CHARS` overall, with a pointer to `detail: "full"` when something is clipped. `list_tables` caps names and prefers `filter`.

## Retrieval: names, not just vectors

With an e5 index every cosine score lands in a narrow band — on this index, 0.79 to 0.83 for everything. That is enough to rank `tbl_payment_link_preset_type` above `tbl_payment` for "how many payments were created last month", which is how a simple question turns into eight irrelevant tables and a wrong query.

So the table *inventory* is matched too. A table wins on name when every token in its name was asked for: "pos terminals" fully covers `tbl_pos_terminal` but only a third of `tbl_pos_terminal_charge_payment_mapping`, and it beats the bare `tbl_pos` because it accounts for more of the question. Partial matches are left to the vector search. This runs against an inventory that is already in memory, so it costs nothing per query, and it is a pure accelerator — while the inventory is still warming, search behaves exactly as it would without it.

Duplicate environments are collapsed the same way. An index holding `speed_core_live` and `speed_core_test` used to return both copies of every table and spend half of `top_k` on duplicates; now the preferred copy is returned with `_same table also in: speed_core_test_` underneath. Preference is `database` argument, then `DEFAULT_DATABASE`, then the database with the most tables.

## Run it locally

```bash
npm install
```

Then create `.env` next to the server with your Pinecone key — everything else has a default:

```ini
PINECONE_API_KEY=...
PINECONE_INDEX=ask-db
SQL_DIALECT=MySQL
```

### Claude Code

The CLI, the desktop app and the IDE extensions share one config, so this registers the server for all three:

```powershell
# from the repo root — records an absolute path, so it works in any folder
claude mcp add askdb --scope user -- node "$PWD\src\server.js"
```

Check it with `claude mcp list` (`askdb: ... ✓ Connected`), then restart the desktop app or IDE window — MCP servers load at startup.

User scope is deliberate: the point is to ask database questions while working in your _other_ repos. A project-scoped `.mcp.json` would only resolve when Claude Code is started at this repo's root.

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

**From the dashboard:** push the repo to GitHub, then [vercel.com/new](https://vercel.com/new) → import it. Application Preset **Other**, no build command, no output directory — Vercel picks up `api/` on its own.

Do not pick the **Node** preset. Vercel's backend presets scan for an app entrypoint at `app.*`, `index.*`, `server.*`, `src/app.*`, `src/index.*` or `src/server.*`, and this repo has [src/server.js](src/server.js) — the stdio entry point. The preset boots it expecting an Express-style app, finds no default export and no port listener, and the whole deployment dies with `FUNCTION_INVOCATION_FAILED` before `api/` is ever built. [vercel.json](vercel.json) sets `"framework": null` to force **Other** regardless of the dashboard setting, so this is already handled — just don't override it.

**Or from the CLI:**

```bash
npx vercel login
npx vercel link
npx vercel deploy --prod
```

### 3. Set environment variables

Project Settings → Environment Variables, scoped to **Production** (add Preview too if you want preview deploys to work):

| Variable           | Value                                        |
| ------------------ | -------------------------------------------- |
| `PINECONE_API_KEY` | your Pinecone key                            |
| `MCP_AUTH_TOKEN`   | the token from step 1                        |
| `DEFAULT_DATABASE` | optional, e.g. `speed_core_live` — see below |
| `SQL_DIALECT`      | optional, e.g. `MySql`                       |

Or via CLI: `npx vercel env add PINECONE_API_KEY production`

**Redeploy after adding them** — environment variables are baked in at deploy time, so an existing deployment won't pick them up.

### 4. Turn off Deployment Protection

Settings → **Deployment Protection**. If Vercel Authentication is on for production, every request to `/mcp` gets bounced to an SSO login page and no MCP client can connect. Turn it off for production (your bearer token is the access control), or issue a Protection Bypass token and send it as well.

This is the single most common reason a deploy that looks fine returns HTML instead of JSON.

### 5. Verify

```bash
curl https://ask-db-mcp.vercel.app/health
```

```json
{
  "status": "ok",
  "index": "ask-db",
  "env": { "PINECONE_API_KEY": true, "MCP_AUTH_TOKEN": true }
}
```

`env` reports presence only, never values. A `503` with `"status": "misconfigured"` means a variable is missing or you haven't redeployed since adding it.

Then the endpoint itself:

```bash
curl -X POST https://ask-db-mcp.vercel.app/mcp \
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
claude mcp add --transport http askdb https://ask-db-mcp.vercel.app/mcp \
  --scope user \
  --header "Authorization: Bearer <token>"
```

**Claude Desktop / Cursor** — neither speaks a static bearer token natively (their built-in connectors expect OAuth), so bridge with `mcp-remote`. On Windows the config lives at `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "askdb": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://ask-db-mcp.vercel.app/mcp",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer <token>"
      }
    }
  }
}
```

The token goes in `env`, not in `args`, and there is **no space after the colon** in `Authorization:${AUTH_HEADER}`. Claude Desktop on Windows and Cursor both have a bug where spaces inside `args` are not escaped when invoking `npx`, which mangles the header; routing the value through an environment variable sidesteps it, since spaces are fine there.

Restart Claude Desktop fully after editing — MCP servers are loaded at startup. If it fails to connect, try `"command": "cmd"` with `"args": ["/c", "npx", "-y", "mcp-remote", ...]`; Windows sometimes can't resolve `npx` when it is spawned without a shell.

**ChatGPT:** add a connector pointing at `https://ask-db-mcp.vercel.app/mcp` with an `Authorization: Bearer <token>` header.

Teammates need nothing installed — just the URL and the token.

---

## Configuration

All optional except the API key. The same names work as Vercel environment variables.

| Variable                                     | Default                 | Notes                                      |
| -------------------------------------------- | ----------------------- | ------------------------------------------ |
| `PINECONE_API_KEY`                           | —                       | Required                                   |
| `MCP_AUTH_TOKEN`                             | —                       | Required when hosted; unused over stdio    |
| `PINECONE_INDEX`                             | `ask-db`                |                                            |
| `PINECONE_NAMESPACE`                         | _(default ns)_          |                                            |
| `TOP_K` / `MAX_TOP_K`                        | `8` / `30`              | Chunks retrieved per search                |
| `EMBED_MODEL`                                | `multilingual-e5-large` | **Must match the model you upserted with** |
| `DEFAULT_DATABASE`                           | _(all)_                 | Scope every lookup to one database         |
| `SQL_DIALECT`                                | `MySQL`                 | Passed to the model as a hint              |
| `TEXT_FIELDS` / `TABLE_FIELDS` / `DB_FIELDS` | _(auto-detected)_       | Candidate metadata keys, tried in order    |
| `LIST_SCAN_LIMIT`                            | `1000`                  | Cap on `list_tables` scanning              |

Output budget — lower these to spend fewer tokens, raise them to see more schema at once:

| Variable               | Default | Notes                                              |
| ---------------------- | ------- | -------------------------------------------------- |
| `MAX_TABLES`           | `4`     | Tables rendered in one answer                      |
| `MAX_CHARS_PER_TABLE`  | `1400`  | Per-table DDL cap in `compact` detail              |
| `MAX_RESPONSE_CHARS`   | `7000`  | Whole-response cap                                 |
| `MAX_LISTED_TABLES`    | `120`   | Names printed by `list_tables` before it asks for a `filter` |
| `CACHE_TTL_MS`         | `600000`| In-process cache for searches, fetches and the inventory; `0` disables |
| `INVENTORY_WAIT_MS`    | `3000`  | How long a search waits for a table scan still warming up; `0` never waits |
| `SCAN_CONCURRENCY`     | `6`     | Record batches fetched in parallel while scanning        |

When to ask rather than guess:

| Variable           | Default | Notes                                                                       |
| ------------------ | ------- | --------------------------------------------------------------------------- |
| `ASK_WHEN_UNSURE`  | `true`  | `false` always answers with the best guess                                   |
| `AMBIGUITY_GAP`    | `0.015` | Biggest score drop in the top results, as a fraction of the best score, below which the ranking counts as flat. Raise it to be asked more often |
| `MAX_CANDIDATES`   | `8`     | Length of the shortlist                                                     |
| `MIN_SCORE`        | `0`     | Extra absolute floor; `0` disables it                                       |
| `ELICIT`           | `true`  | Prompt the user directly when the client supports MCP elicitation           |

The server samples the index on first use to detect which metadata fields your records use and whether the index has integrated embedding, so the defaults usually work unchanged.

## Three things worth knowing

**The embedding model must match.** If `EMBED_MODEL` is not the model the schema was upserted with, every score collapses to near-zero and results are noise — the vectors are effectively random relative to each other. You'll see this as unrelated tables coming back with scores around `0.01` instead of `0.8`. This index was built with `multilingual-e5-large`. (Irrelevant if the index has integrated embedding — `list_tables` reports which.)

**`DEFAULT_DATABASE` is a trade, not a free win.** Duplicate `*_live` / `*_test` copies are already collapsed, so scoping is no longer needed to stop the model mixing environments. Scoping does make retrieval sharper — but it also hides every table that lives *only* somewhere else. On this index `tbl_user` and `tbl_account_kyc` exist in `speed` alone, so `DEFAULT_DATABASE=speed_core_live` would make them unfindable. Leave it unset unless one database really is the whole story.

**Startup is warmed, not lazy.** The Pinecone SDK costs ~6s to import and the table scan another ~5s. Both now run in the background right after the MCP handshake ([`warmup()`](src/pinecone.js)) instead of inside the first tool call, and the two overlap, so priming lands at ~11s and is normally finished before anyone asks anything. Nothing awaits it and nothing depends on it: a question that arrives mid-warm-up waits `INVENTORY_WAIT_MS` (3s) for the inventory and then answers without name matching. Hosted, module scope runs once per container, so a warm container is already primed — which is why `api/mcp.js` keeps its 60s `maxDuration` in [vercel.json](vercel.json) for the cold case.

The scan got cheaper too. Records in this index are keyed `database.table`, one per table, so after fetching a single batch to confirm that convention actually holds, the remaining table names are read straight from the ids and ~386 records of DDL are never pulled over the wire. Scan work dropped from ~11s to ~5s, and the result is identical to reading every record's metadata — verified against a full fetch. Any batch containing an id that does not parse is still fetched, and an index that does not follow the convention at all falls back to fetching everything, six batches at a time.

**Repeat questions are free.** Searches, table fetches and the inventory are cached in process for `CACHE_TTL_MS` (10 minutes), keyed on every argument. A repeated search returns in ~0ms instead of ~700ms, which matters most when a conversation circles the same two tables.

## Layout

| File                               | Role                                               |
| ---------------------------------- | -------------------------------------------------- |
| [src/server.js](src/server.js)     | stdio entry point                                  |
| [src/mcp.js](src/mcp.js)           | Tool definitions — the MCP surface                 |
| [src/pinecone.js](src/pinecone.js) | Retrieval: search, exact fetch, field detection, warm-up |
| [src/lexical.js](src/lexical.js)   | Table-name matching over the inventory             |
| [src/format.js](src/format.js)     | Renders hits into the schema block the model reads |
| [src/cache.js](src/cache.js)       | In-process TTL cache for Pinecone round trips      |
| [src/config.js](src/config.js)     | Env loading and defaults                           |
| [api/mcp.js](api/mcp.js)           | Hosted MCP endpoint — `/mcp`, bearer auth          |
| [api/health.js](api/health.js)     | Hosted config check — `/health`, unauthenticated   |
| [vercel.json](vercel.json)         | Routing and function duration                      |
