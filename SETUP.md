# Setting up askDB MCP

Instructions for someone who is *not* the author. Pick one of two routes.

| | Route A — hosted | Route B — local |
| --- | --- | --- |
| What you install | nothing | Node 18+, this repo |
| What you need handed to you | a URL + access token | your own Pinecone API key |
| Setup time | one command | ~2 minutes |
| Best for | teams, non-developers, ChatGPT users | developers who want to change the server |

Route A is the better default for a team: the Pinecone key stays on one machine instead of being copied onto everyone's laptop.

---

## Route A — connect to a hosted instance

Ask the maintainer for the endpoint URL and your bearer token, then:

```bash
claude mcp add --transport http askdb https://<host>/mcp \
  --scope user \
  --header "Authorization: Bearer <your-token>"
```

Verify with `claude mcp list` — you want `askdb: ... ✓ Connected`. That's it; there is nothing to install or configure.

For ChatGPT, add the same URL as a connector in Developer mode with the `Authorization: Bearer <your-token>` header. ChatGPT cannot use Route B at all — it only speaks remote MCP over HTTP.

---

## Route B — run it yourself

### 1. Get the code and install

```bash
git clone <repo-url> askdb-mcp
cd askdb-mcp
npm install
npm run setup
```

`npm run setup` creates your `.env` from the template. It never overwrites an existing one.

### 2. Add your Pinecone key

Open `.env` and set `PINECONE_API_KEY`. **Get your own key** from [app.pinecone.io](https://app.pinecone.io) → API Keys, for the project that owns the `ask-db` index — don't reuse someone else's. `.env` is gitignored, so your key never leaves your machine.

Everything else in `.env` already has a working default.

### 3. Check it before wiring it up

```bash
npm run doctor
```

This is the step that saves you an afternoon. It prints the index config, which metadata fields your records use, and a sample search with real relevance scores. You want to see scores around **0.8**, and the final line `✓ schema text will be read from "ddl"`.

If scores are near **0.01**, `EMBED_MODEL` in `.env` does not match the model the schema was upserted with — nothing else will work until that matches. See [README.md](README.md#two-things-worth-knowing).

### 4. Connect your client

**Claude Code** (CLI, desktop app and IDE extensions all share this config):

```bash
# from inside the repo — records an absolute path, so it works from any folder
claude mcp add askdb --scope user -- node "$(pwd)/src/server.js"
```

On Windows PowerShell:

```powershell
claude mcp add askdb --scope user -- node "$PWD\src\server.js"
```

Confirm with `claude mcp list` — you want `askdb: ... ✓ Connected`. Restart the desktop app or IDE window afterwards, since MCP servers load at startup.

Use `--scope user`, not a project-scoped `.mcp.json`: the whole point is asking database questions while you work in your *other* repos, and a project config only resolves when Claude Code is started at this repo's root.

**Claude Desktop** (the chat app) — edit `claude_desktop_config.json`:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "askdb": {
      "command": "node",
      "args": ["/absolute/path/to/askdb-mcp/src/server.js"]
    }
  }
}
```

Use an absolute path, and on Windows escape the backslashes (`D:\\path\\to\\src\\server.js`). Quit the app completely — from the tray or menu bar, not just the window — and reopen.

**Cursor** — same JSON, added through Settings → MCP.

Credentials come from `.env` next to the server, so no keys go in any client config. If you would rather pass the key explicitly, `claude mcp add -e PINECONE_API_KEY=... askdb -- node ...` also works; anything already in the environment takes precedence over `.env`.

---

## Using it

Ask a data question in plain language:

> which accounts had failed withdrawals last week?

The model calls `search_schema` on its own, gets the relevant tables back, and writes the SQL. You don't invoke the tools by hand. askDB never touches your database — it only returns schema, so the query it produces is yours to run wherever you normally run queries.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `✗ Failed to connect` in `claude mcp list` | Wrong path, or `npm install` not run. Try `npm start` directly — it should print `[askdb-mcp] stdio ready`. |
| Tools don't appear in a running client | MCP servers load at startup; restart the app or IDE window. |
| Results are unrelated tables, scores ~0.01 | `EMBED_MODEL` doesn't match the upsert model. Run `npm run doctor`. |
| `PINECONE_API_KEY is not set` | `.env` is missing or still has the placeholder. Run `npm run setup`. |
| `401 Unauthorized` on Route A | Bad or missing bearer token. |
| Same table appears two or three times | The index holds several environments. Set `DEFAULT_DATABASE` in `.env`. |
| Server takes a few seconds on the first question | Expected — the Pinecone SDK is imported lazily on first use, then cached. |

`npm run smoke` drives the whole server with a real MCP client if you want to check it end to end without a chat app.

---

## For the maintainer: publishing this

This directory is not yet a git repo. To let anyone clone it:

```bash
git init
git add .
git commit -m "askDB MCP server"
git remote add origin <your-repo-url>
git push -u origin main
```

`.gitignore` already excludes `.env` and `node_modules`, so no secrets are committed — worth confirming with `git status` before the first push.

To host Route A, deploy to Netlify — **[DEPLOY.md](DEPLOY.md)** walks through it, and the last section covers other runtimes (Cloudflare Workers, containers, VMs). Anyone with the URL and a valid token can read your entire schema, so don't skip `MCP_AUTH_TOKEN`; the deployed `/mcp` refuses to serve without it.
