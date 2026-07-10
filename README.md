# Rever

**Local, PR-style code review that closes the loop with Claude Code.**

Generating code with an AI agent is easy; *reviewing* it and driving revisions is not — you
end up pasting snippets, line numbers, and file paths, with no way to comment on a change set
as a whole. Rever recreates the GitHub pull-request experience **locally**: point it at a repo,
review the diff in your browser, leave inline comments and a summary, and the agent reads those
comments back through MCP, revises, and replies — all against a snapshot history that survives
re-staging and amends.

```
 stage changes ─▶ agent: start_review ─▶ review in browser ─▶ publish
                                                                  │
        create_snapshot ◀─ agent edits ◀─ agent: get_review_comments ◀─┘
```

## Requirements

- **Node.js 22+** (developed/tested on Node 24)
- **git**
- **Claude Code** (for the agent side)

## Install

```bash
git clone <your-clone-url> rever
cd rever
npm install
npm run build        # compiles the server (dist/server) and web bundle (dist/web)
```

## Run the daemon

Rever is a single long-running daemon that serves the web UI, a REST API, and the MCP
endpoint — all on one port. It owns a SQLite database at `~/.rever/rever.db`.

```bash
node bin/rever.js     # → Rever daemon listening on http://localhost:7910
```

Leave it running. Because the MCP transport is HTTP, Claude Code **connects to** the daemon
(it does not launch it), so the daemon must be up whenever you use the tools.

Optional — make a global `rever` command:

```bash
npm link              # then just run: rever
```

### Configuration

| Env var       | Default            | Purpose                          |
| ------------- | ------------------ | -------------------------------- |
| `REVER_PORT`  | `7910`             | Port the daemon listens on       |
| `REVER_HOME`  | `~/.rever`         | Directory for the DB + pidfile   |

## Register with Claude Code

One-time, with the daemon running:

```bash
claude mcp add --transport http rever http://localhost:7910/mcp
# or, to make it available in every project:
claude mcp add --transport http --scope user rever http://localhost:7910/mcp
```

Start a **fresh** Claude Code session (MCP servers load at session start). Verify with
`claude mcp list` or `/mcp` inside a session — you should see `rever` and its tools.

## Usage — the review loop

1. **Stage what you want reviewed.** By default Rever reviews your **staged** diff
   (`git diff --cached`), so the staging area is your selection:
   ```bash
   git add <the files you want reviewed>
   ```
2. **Ask the agent to start a review.** In Claude Code: *"start a Rever review of this repo."*
   It calls `start_review` and returns a URL like `http://localhost:7910/review/1`.
3. **Review in the browser.** Open the URL. You'll see the diff (syntax-highlighted, with a
   snapshot switcher). Hover a line and click **+** to leave an inline comment; use
   **Review summary** to add an overall note and a verdict (approve / request changes / comment).
4. **Publish.** Your comments are drafts until you click **Publish** — then they become
   visible to the agent as one batch.
5. **Hand off.** Tell the agent your comments are ready. It calls `get_review_comments`,
   reads them (with the anchored code), revises, and can `add_comment` (reply) or
   `resolve_thread`. When it re-stages and calls `create_snapshot`, you get a fresh review
   surface for the next round.

> **Note:** live updates (M8) aren't built yet — after the agent replies or resolves, **refresh
> the browser** to see the changes. Nothing is lost; it's just not pushed automatically.

### Reviewing committed history instead of staged changes

`start_review` accepts an optional `selector` — any git revspec — to review committed history:
`main..HEAD`, `A...B`, a branch name, etc. Omit it to review the staged diff (the default).

## MCP tools

| Tool                    | What it does                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| `start_review`          | Start a new review of a repo (default: staged diff). Returns a URL. |
| `list_reviews`          | List reviews (newest first), optionally filtered to one repo.       |
| `get_review_comments`   | Pull published threads for a review: location + code snippet + tree. |
| `add_comment`           | Reply in a thread (published immediately).                          |
| `resolve_thread`        | Mark a thread resolved.                                             |
| `update_thread_status`  | Set a thread `open` / `resolved`.                                   |
| `create_snapshot`       | Freeze a new snapshot after revising (starts empty of comments).    |
| `get_snapshot_diff`     | Full frozen diff text for a snapshot (or one file).                 |

## Development

```bash
npm run dev        # server (tsx watch) + Vite dev server (proxied) on :5173
npm run test       # server test suite (node:test)
npm run coverage   # tests + c8 coverage (95% line/branch gate on core modules)
npm run e2e        # Playwright browser end-to-end (diff viewer + commenting)
npm run typecheck  # tsc --noEmit
```

- **Server** — `src/server/` (Express + better-sqlite3, MCP via `@modelcontextprotocol/sdk`).
- **Web** — `src/web/` (React + Vite, Shiki syntax highlighting).
- **Shared types** — `src/types/`.

## Scope & limitations

- Personal, **single-user, localhost-only** tool — no auth.
- **No live sync yet** (refresh to see agent updates) — planned as M8.
- Comments are **snapshot-scoped**: each snapshot keeps its own diff + comments; new
  snapshots start empty (they don't carry comments forward).
- Quoted/non-ASCII filenames in diffs aren't fully decoded (a known edge).
