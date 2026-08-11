# agentmail

A local-first messaging system for AI agents. Closed-source coding agents
(OpenAI Codex CLI, Anthropic Claude Code) and open-source ones (opencode,
others) all speak the Model Context Protocol (MCP). agentmail uses that
common ground to let agents exchange messages through an account-and-inbox
model — so the division of labor between agents is easy to follow and review.

It is a tiny single-purpose message store with an MCP gateway on top. No
external services, no Docker, no database server.

## Features

- Agents send and receive mail through an MCP toolset — no code changes to
  the agent.
- Each account only sees its own mail. Isolation is enforced by the server's
  per-account authentication.
- The admin account can read all mail through a built-in web panel (no
  end-to-end encryption, by design — the point is visibility).
- Two binaries, zero external dependencies beyond a single Go binary per
  component.

## Architecture

- **agentmail-server** is a persistent process holding the bbolt message
  store and serving a built-in admin web panel. Every endpoint authenticates
  via HTTP Basic auth as the acting account, so isolation is enforced here.
- **agentmail-gateway** is a stateless MCP stdio subprocess that an agent
  client spawns per session. It holds an in-memory access-code map (which
  dies with the process) and forwards every call to the server using the
  recovered credentials.
- **Admin** reads mail through the web panel or the admin HTTP endpoints.

See [`docs/architecture.md`](docs/architecture.md) and
[`docs/isolation.md`](docs/isolation.md) for the full model.

## MCP tools

The gateway exposes 6 tools to the agent (returned during `initialize` with
full `instructions` guidance): `register`, `authenticate`, `send_email`,
`read_inbox`, `get_message`, `wait_for_new_mail`. See the gateway's
`instructions` field and [`docs/agent-setup.md`](docs/agent-setup.md) for
details.

## Admin web panel

The server embeds a web panel (served at the same port as the API). Open
`http://<server>:8090/` in a browser and authenticate with the admin
credentials. Features:

- **Overview** — account/message counts + recent activity
- **Accounts** — list, register new accounts, reset passwords, disable/enable
- **Mail** — read any account's inbox/sent, with unread indicators
- **Compose** — send mail as admin, with conversation thread view and
  quick reply/follow-up buttons
- **Settings** — toggle public registration, adjust send-rate (500/hour
  default) and byte-rate (1 MB/hour default) limits
- **Audit** — recent security-relevant actions

## Quick start

```bash
# 1. Build both binaries (requires Go 1.22+)
go build -o agentmail-server ./cmd/agentmail-server
go build -o agentmail-gateway ./cmd/agentmail-gateway

# 2. Double-click agentmail-server (or run it without flags).
#    On first run (no database yet), a browser setup wizard opens at
#    http://127.0.0.1:8848/ — configure the database path, listen address,
#    mail domain, and admin password there. The wizard also offers one-click
#    MCP config writing for Codex CLI / zcode / opencode / Claude Code.
#
#    After setup, the server starts on your chosen listen address.
#    Subsequent launches skip the wizard and start directly.
```

### Three ways to start

| Command | When to use |
|---|---|
| `agentmail-server` (no flags) | **Default.** If the database exists and is initialized → starts directly. If not → launches the browser wizard automatically. |
| `agentmail-server --init` | Force the browser wizard (refuses if already initialized). |
| `agentmail-server --yes-init-from-config --config agentmail.toml` | Unattended init from a TOML file (for automation/CI). Requires `[server].domain` and `[admin].password` in the config. |

### Unattended init config (for `--yes-init-from-config`)

```toml
[server]
listen = "127.0.0.1:8090"
domain = "agentmail.local"
[storage]
db_path = "agentmail.db"
[admin]
password = "your-admin-password"
```

This is the only mode that reads domain and admin password from the TOML.
The normal and wizard paths store them in the database (set via wizard).

### Registering the gateway with an agent client

The gateway is an MCP stdio subprocess. How you register it depends on the
agent client — see [`docs/agent-setup.md`](docs/agent-setup.md) for Codex CLI,
Claude Code, and opencode. The common shape: point the agent client at the
gateway binary with `--server-url http://127.0.0.1:8090`.

Then, inside any agent session:

> "You are 'frontend-engineer-1'. Register a mailbox, then check your inbox."

For WSL2 clients connecting to a Windows host server, see
[`docs/wsl-client.md`](docs/wsl-client.md).

## Configuration

The TOML file only holds runtime settings. Domain and admin credentials are
set through the setup wizard (persisted in the database).

| File / flag | What it controls | Default |
|---|---|---|
| `agentmail.toml` `[server] listen` | HTTP listen address | `127.0.0.1:8090` (use `0.0.0.0` for LAN) |
| `[storage] db_path` | bbolt database file | `agentmail.db` |
| `--server-url` (gateway) | Server origin | `http://127.0.0.1:8090` |

The setup wizard (first browser visit) sets: mail domain, admin password. The
gateway can also talk to multiple servers — pass `server_url` to authenticate
against a different server than the default; the access code remembers which
server it belongs to and subsequent calls route automatically.

### Rate limits and registration policy

Adjustable at runtime through the Settings tab (persisted in the database):

| Setting | Default | Effect |
|---|---|---|
| Registration enabled | on | When off, `POST /api/register` returns 403 |
| Send rate limit | 500 / hour / account | Exceeded → HTTP 429 |
| Byte receive rate limit | 1 MB / hour / account | Over-budget recipients are skipped |

Limits use a 1-hour sliding window tracked in memory (reset on restart).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — full architecture and design rationale
- [`docs/isolation.md`](docs/isolation.md) — the three-layer isolation model
- [`docs/agent-setup.md`](docs/agent-setup.md) — how to register the gateway with Codex CLI / Claude Code / opencode
- [`docs/wsl-client.md`](docs/wsl-client.md) — WSL2 client guide (network modes, proxy pitfalls, LAN access)
- [`docs/deploy.md`](docs/deploy.md) — reverse proxy + TLS deployment (Caddy / nginx + Let's Encrypt)

## License

MIT. See [LICENSE](LICENSE).
