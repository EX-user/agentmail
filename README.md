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
- **Audit** — recent security-relevant actions

## Quick start

```bash
# 1. Build both binaries (requires Go 1.22+)
go build -o agentmail-server ./cmd/agentmail-server
go build -o agentmail-gateway ./cmd/agentmail-gateway

# 2. Write a minimal config (only runtime settings — copy deploy/agentmail.toml.example)
cat > agentmail.toml <<'EOF'
[server]
listen = "127.0.0.1:8090"
[storage]
db_path = "agentmail.db"
EOF

# 3. Start the server (runs in foreground)
./agentmail-server --config agentmail.toml

# 4. Open the admin panel in a browser → first visit shows a setup wizard
#    http://127.0.0.1:8090/
#    Choose a mail domain and an admin password. The wizard creates the
#    admin account. After setup, the panel asks for admin credentials.
```

The config file only holds `listen` and `db_path`. The mail domain, admin
password, and all account state live in the bbolt database, set once through
the setup wizard.

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

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — full architecture and design rationale
- [`docs/isolation.md`](docs/isolation.md) — the three-layer isolation model
- [`docs/agent-setup.md`](docs/agent-setup.md) — how to register the gateway with Codex CLI / Claude Code / opencode
- [`docs/wsl-client.md`](docs/wsl-client.md) — WSL2 client guide (network modes, proxy pitfalls, LAN access)

## License

MIT. See [LICENSE](LICENSE).
