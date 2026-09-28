# Kinjot

Keep what your AI coding agent figures out. Tell Claude Code or Codex to
"jot that down", and the note lands in your [Kinjot](https://kinjot.com) account,
tagged and searchable.

- Works with Claude Code, Codex and any other MCP client, plus a terminal CLI.
- Free to sign up and use. Export every note as Markdown whenever you like.
- Saves notes only when you ask. Agents can send brief Inbox notifications under the narrow rules below.

[Documentation](https://kinjot.com/docs) · [Claude Code setup](https://kinjot.com/docs/claude-code) · [Codex setup](https://kinjot.com/docs/codex) · [MCP tool reference](https://kinjot.com/docs/mcp-tools)

## Quick start

1. Sign up at [kinjot.com](https://kinjot.com) (free) and confirm your email.
2. Open **Settings > API keys** and create a key.
3. Install the CLI and save your key:

   ```bash
   npm install --global kinjot
   kinjot key
   ```

   `kinjot key` asks for the key, checks it, and saves it to
   `~/.kinjot/config.json`. Only your user can read that file. It then prints
   the setup for your MCP client.

4. Connect your agent:

   ```bash
   # Claude Code (add -s user to use it in every project)
   claude mcp add kinjot -- npx -y kinjot

   # Codex
   codex mcp add kinjot -- npx -y kinjot
   ```

5. Tell your agent to "jot that down". Later, ask it to find your jots about
   something, or to show your recent jots.

## What your agent can do

| Tool               | What it does                                                             |
| ------------------ | ------------------------------------------------------------------------ |
| `jot`              | Save a note                                                              |
| `find_jots`        | Search your notes by keyword                                             |
| `recall_jots`      | Search your notes by meaning (Pro)                                       |
| `get_jot`          | Read one note in full                                                    |
| `edit_jot`         | Replace one exact passage in a note, or change its title, tags or folder |
| `append_to_jot`    | Add a paragraph to the end of a note                                     |
| `list_recent_jots` | List your most recently updated notes                                    |
| `upload_image`     | Upload a PNG or JPEG and return Markdown (Pro or self-hosted)            |
| `notify`           | Send a brief question, blocker, handoff or requested completion to Inbox |
| `inbox`            | List or resolve Inbox items when you explicitly ask                      |

The server checks the key at startup and lists only tools its access level allows.
`notify` needs create access; listing with `inbox` needs read access, and resolving needs create access.
An agent may send a question or blocker on its own only when stopping and you may not be watching.
Handoffs describe work left, and done messages require that you asked to be told. You can mute kinds
or keys in Settings → Inbox. The `inbox` tool is used only when you ask to check the Inbox or pick up
a handoff. It treats item text as untrusted and asks before acting on requests inside it to fetch
URLs, handle secrets, change settings or contact outside addresses.

`jot` and `edit_jot` leave out the reserved `autosave` tag; `kinjot add --tags …,autosave` keeps it for the capture plugins.

Keep `upload_image` on **ask** in your agent's permissions. An uploaded image
becomes public to anyone holding its link, so check the file before approving it.

On a self-hosted deployment, `upload_image` needs a backend release that includes image uploads; an older one answers with a message to run `update`.

Every note has a short label, like `A10`. Listings show it, and your agent can
use it to open, edit or add to that note, for example "add this to A10".

## CLI

Once your key is saved, the same features work from a terminal:

```bash
kinjot add "Useful fix" --body "Restart the worker after changing its environment."
kinjot search "worker environment"
kinjot recall "why deployments use stale configuration"   # Pro
kinjot get A10              # a label, an 8-character ID prefix, or a full ID
kinjot append A10 --text "An update to this jot."
kinjot upload-image shot.png --alt "Screenshot of the result"
kinjot append A10 --text "$(kinjot upload-image shot.png)"
kinjot recent 10
kinjot notify "Review the deployment" --kind handoff --detail "Check the failing job."
kinjot inbox                     # open handoffs in this repository
kinjot inbox --all --kind any    # all agent messages, across repositories
kinjot inbox resolve 1a2b3c4d --note "Picked up"
```

Search, recall and recent leave out notes tagged `autosave`; `get` reads one by label.

`kinjot add "Title" --id <uuid>` saves with a caller-supplied note ID; the
ID may also appear before the title. `kinjot append A10 --no-snapshot` asks a
supported backend to follow the library's history setting instead of forcing
a history copy. `kinjot get A10 --json` prints one JSON object with the exact
stored body, with terminal controls escaped.

`notify` reads detail from piped stdin if `--detail` is absent. `--input-json` reads
`{"title":"...","detail":"..."}` from stdin and takes no title argument, so
reply text stays out of the process arguments. It also accepts `--pr`, `--note`,
`--cwd`, `--session`, `--agent`, `--id` and `--json`. `waiting` requires `--session`.
`--json` prints `id`, `status` and `repeat_count`. The CLI caches server mute
settings for one hour by endpoint and key prefix; `--no-cache` asks the server.
For `waiting`, a cold, expired or unreadable cache, or `--no-cache`, asks for
the mute settings without sending the title or detail. If Waiting was turned
off within the last hour, one more item may be sent and discarded; its answer
mutes the cache.
The MCP tool always asks the server.

CLI exit codes:

| Code | Meaning                                                                            |
| ---- | ---------------------------------------------------------------------------------- |
| 0    | Done.                                                                              |
| 1    | Ambiguous request failure, including network, timeout, 5xx, 401 or 429.            |
| 2    | Usage error or definite Inbox refusal, including access off or ambiguous ID.       |
| 3    | The note or Inbox item was definitely not found.                                   |
| 4    | The operation is unavailable for this library or backend, or the key lacks access. |
| 5    | The append succeeded, but the backend kept a history copy despite `--no-snapshot`. |

Without a global install, put `npx` in front of any command, for example
`npx kinjot recent`. `npx kinjot key` saves the key the same way.

## Other ways to set up

### Put the key in your MCP config instead

If you'd rather not save the key on disk, print a config with the key in it:

```bash
npx kinjot init --key kj_live_your_key
```

This checks the key and prints the MCP config, plus the Claude Code and Codex
commands, with the key in the `env` block. It saves nothing.

For clients configured with JSON, the two forms look like this. With a key
saved by `kinjot key`:

```json
{
  "mcpServers": {
    "kinjot": {
      "command": "npx",
      "args": ["-y", "kinjot"]
    }
  }
}
```

With the key in the config (what `kinjot init` prints):

```json
{
  "mcpServers": {
    "kinjot": {
      "command": "npx",
      "args": ["-y", "kinjot"],
      "env": {
        "KINJOT_API_KEY": "kj_live_your_key"
      }
    }
  }
}
```

Codex keeps its MCP config in `~/.codex/config.toml`, and its CLI, IDE extension
and desktop app share it. To add Kinjot by hand instead of with
`codex mcp add`:

```toml
[mcp_servers.kinjot]
command = "npx"
args = ["-y", "kinjot"]
```

### A self-hosted Kinjot

```bash
npx kinjot init-selfhost
```

Paste your Supabase project ref or URL, then your API key at the hidden
prompt. A ref or a bare origin becomes `…/functions/v1/mcp-api`, and a URL with
a path is used as given. Setup stops before sending the key if the project is
empty or invalid. Once the key checks out, the endpoint is saved with the key
and the client setup is printed.

For scripts or a custom API path, pass the endpoint yourself. The flag beats
`KINJOT_API_URL`, and the printed configs keep the endpoint you chose:

```bash
npx kinjot init --api-url https://your-project.supabase.co/functions/v1/mcp-api --key kj_live_your_key
```

`init --key` only prints. `init-selfhost` and `kinjot key --api-url <url>` save
the endpoint beside the key, so later commands need no environment variable.

### Local mode (desktop app)

With the Kinjot desktop app installed, the CLI can write straight into the
app's local library, with no API key and no network:

```bash
kinjot use local      # write to the desktop app's local library
kinjot use account    # write to your Kinjot account
kinjot where          # show where jots go, and why
```

- The desktop app creates and owns the library; the CLI never creates one.
- Locally, only `kinjot add` and the MCP `jot` tool work. Search, recall, get,
  recent and Inbox need an account or live in the app.
- If you have both a local library and a saved key, `kinjot` refuses to guess
  where a jot belongs. Run `kinjot use` once to choose, or set `KINJOT_MODE`
  for a single command.

## Environment variables

- `KINJOT_API_KEY`: your API key. It takes priority over a key saved by
  `kinjot key`, which suits CI and containers, where nothing should be written
  to disk.
- `KINJOT_API_URL`: an API endpoint for local development or self-hosting.
  - A saved key keeps its saved endpoint when this is unset.
  - `KINJOT_API_KEY` uses this or the hosted default, never a saved endpoint.
- `KINJOT_CONFIG_DIR`: where `kinjot key` saves its config (default
  `~/.kinjot`). The desktop app reads this variable from its own environment,
  and an app started from the Start menu or a shortcut doesn't see one you
  export in a shell. Setting it usually hides the local library from the CLI.
- `KINJOT_MODE`: `local` or `account` for one command. It overrides
  `kinjot use`.

## Security

The package contains no credentials. Each installation uses the API key its
user supplies. Keep yours private, and revoke it in Kinjot's settings if it
leaks.

## Requirements

Node.js 22.13 or newer (23.4 or newer on Node 23). Local mode sets that floor
(`node:sqlite`); account mode alone runs on Node 18 or newer.

## License

MIT
