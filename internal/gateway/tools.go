package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/agentmail/agentmail/internal/httpclient"
)

// toolDef describes one MCP tool for tools/list.
type toolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

func (s *Server) handleToolsList(req rpcRequest) rpcResponse {
	tools := []toolDef{
		{
			Name:        "register",
			Description: "Register a new mail account with a semantic identity. Returns the account address and a generated password. Store the password in session memory; you'll need it to authenticate. Optional server_url targets a different agentmail server than the default.",
			InputSchema: schemaObject(map[string]any{
				"name":       prop("ASCII local-part, e.g. 'frontend-engineer-1'", "string", true),
				"server_url": prop("Server origin, e.g. http://10.0.0.5:8090. If omitted, uses the default server this gateway started with.", "string", false),
			}, []string{"name"}),
		},
		{
			Name:        "authenticate",
			Description: "Exchange address + password for a short-lived access code. The code is used by send_email/read_inbox/get_message/wait_for_new_mail and expires after a limited time or number of calls. Optional server_url targets a different agentmail server than the default; the access code remembers which server it belongs to, so subsequent calls route automatically.",
			InputSchema: schemaObject(map[string]any{
				"address":    prop("Account address, e.g. 'frontend-engineer-1@agentmail.local'", "string", true),
				"password":   prop("Account password from register", "string", true),
				"server_url": prop("Server origin, e.g. http://10.0.0.5:8090. If omitted, uses the default server this gateway started with.", "string", false),
			}, []string{"address", "password"}),
		},
		{
			Name:        "send_email",
			Description: "Send a plain-text email from the account bound to the access code.",
			InputSchema: schemaObject(map[string]any{
				"access_code": prop("Access code from authenticate", "string", true),
				"to":          prop("Recipient address(es), comma-separated string or array", "string", true),
				"subject":     prop("Subject line", "string", true),
				"body":        prop("Plain-text body", "string", true),
			}, []string{"access_code", "to", "subject", "body"}),
		},
		{
			Name:        "read_inbox",
			Description: "List the most recent messages in the account's inbox bound to the access code. Reads do not consume the access code's call budget (only register/authenticate/send_email do), so this is safe to poll. Pass since_id to receive only messages newer than a known message id (ULIDs are time-ordered, so string comparison filters correctly).",
			InputSchema: schemaObject(map[string]any{
				"access_code": prop("Access code from authenticate", "string", true),
				"limit":       prop("Max messages to return (default 20)", "integer", false),
				"since_id":    prop("Only return messages with id strictly greater than this (for polling without repeats)", "string", false),
			}, []string{"access_code"}),
		},
		{
			Name:        "get_message",
			Description: "Fetch the full body of a single message by id.",
			InputSchema: schemaObject(map[string]any{
				"access_code": prop("Access code from authenticate", "string", true),
				"message_id":  prop("Message id from read_inbox", "string", true),
			}, []string{"access_code", "message_id"}),
		},
		{
			Name:        "wait_for_new_mail",
			Description: "Block until at least one new message arrives in the account's inbox, or until the timeout elapses (whichever comes first). 'New' means strictly newer than since_id (by ULID time order). The response always includes last_seen_id (the current newest id seen) — pass it as since_id on your next call to maintain a continuous watch without missing in-between mail. If since_id is omitted on the first call, baseline = current newest id. This is a read-only operation: it does not consume the access code's call budget. Default timeout is 25s; there is no internal cap — set it as high as your agent client allows (e.g. 300).",
			InputSchema: schemaObject(map[string]any{
				"access_code": prop("Access code from authenticate", "string", true),
				"since_id":    prop("Only return messages with id strictly greater than this. On subsequent calls, pass the last_seen_id from the previous response to avoid missing mail.", "string", false),
				"timeout":     prop("Max seconds to block waiting (default 25, no internal cap). Returns whatever has arrived when the timeout fires. Pick the largest value your agent client supports.", "integer", false),
			}, []string{"access_code"}),
		},
		{
			Name:        "duty_watch_guide",
			Description: "Return a concise text guide on how to write a reliable inbox watch loop with wait_for_new_mail. No arguments needed. Read this when you are asked to enter a continuous watch/duty/polling mode.",
			InputSchema: schemaObject(map[string]any{}, []string{}),
		},
		{
			Name:        "server_info",
			Description: "Query the server for structured information. Pass query to select what to return: \"status\" (version/domain), \"stats\" (account/message counts), \"settings\" (registration/rate limits), \"accounts\" (full account list, admin only), \"audit\" (recent audit log, admin only), \"help\" (list all queries). Admin-only queries require access_code from an admin account. This tool is a thin pass-through — new query types are added on the server side, no gateway change needed.",
			InputSchema: schemaObject(map[string]any{
				"query":       prop("What to query: status, stats, settings, accounts, audit, or help (default: help)", "string", false),
				"access_code": prop("Access code from authenticate. Required for admin-only queries (accounts, audit). Omit for public queries.", "string", false),
			}, []string{}),
		},
	}
	return rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{"tools": tools}}
}

func schemaObject(props map[string]any, required []string) map[string]any {
	return map[string]any{"type": "object", "properties": props, "required": required}
}

func prop(desc, typ string, req bool) map[string]any {
	if req {
		desc += " (required)"
	}
	return map[string]any{"type": typ, "description": desc}
}

// --- tools/call dispatch ---

func (s *Server) handleToolsCall(ctx context.Context, req rpcRequest) rpcResponse {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return rpcErr(req.ID, codeInvalidParams, "invalid tools/call params")
	}
	args := map[string]any{}
	if len(params.Arguments) > 0 {
		if err := json.Unmarshal(params.Arguments, &args); err != nil {
			return rpcErr(req.ID, codeInvalidParams, "invalid arguments")
		}
	}

	var (
		result any
		err    error
	)
	switch params.Name {
	case "register":
		result, err = s.toolRegister(ctx, args)
	case "authenticate":
		result, err = s.toolAuthenticate(ctx, args)
	case "send_email":
		result, err = s.toolSend(ctx, args)
	case "read_inbox":
		result, err = s.toolReadInbox(ctx, args)
	case "get_message":
		result, err = s.toolGetMessage(ctx, args)
	case "wait_for_new_mail":
		result, err = s.toolWaitForNewMail(ctx, args)
	case "duty_watch_guide":
		result = s.toolDutyWatchGuide()
	case "server_info":
		result, err = s.toolServerInfo(ctx, args)
	default:
		return rpcErr(req.ID, codeMethodNotFound, "unknown tool: "+params.Name)
	}

	if err != nil {
		return toolResult(req.ID, fmt.Sprintf("error: %v", err), true)
	}
	return toolResultJSON(req.ID, result, false)
}

func rpcErr(id json.RawMessage, code int, msg string) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg}}
}

func toolResult(id json.RawMessage, text string, isError bool) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", ID: id, Result: map[string]any{
		"content": []map[string]any{{"type": "text", "text": text}},
		"isError": isError,
	}}
}

func toolResultJSON(id json.RawMessage, v any, isError bool) rpcResponse {
	buf, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return toolResult(id, fmt.Sprintf("(unmarshallable: %v)", err), true)
	}
	return toolResult(id, string(buf), isError)
}

// --- the five tools ---

func (s *Server) toolRegister(ctx context.Context, args map[string]any) (any, error) {
	name, _ := args["name"].(string)
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("name is required")
	}
	serverURL := strings.TrimSpace(str(args["server_url"]))
	res, err := s.getClient(serverURL).Register(name)
	if err != nil {
		return nil, fmt.Errorf("register: %w", err)
	}
	return map[string]any{
		"address":  res.Address,
		"password": res.Password,
		"hint":     "Store this password in session memory to authenticate later.",
	}, nil
}

func (s *Server) toolAuthenticate(ctx context.Context, args map[string]any) (any, error) {
	address, _ := args["address"].(string)
	password, _ := args["password"].(string)
	serverURL := strings.TrimSpace(str(args["server_url"]))
	address = strings.TrimSpace(address)
	if address == "" || password == "" {
		return nil, fmt.Errorf("address and password are required")
	}
	code, err := s.issueCode(ctx, address, password, serverURL)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"access_code": code,
		"hint":        "Use this for send_email/read_inbox/get_message/wait_for_new_mail. If a later call fails with 'invalid or expired access code', call authenticate again.",
	}, nil
}

func (s *Server) toolSend(ctx context.Context, args map[string]any) (any, error) {
	entry, err := s.consumeCode(str(args["access_code"]))
	if err != nil {
		return nil, err
	}
	client := s.getClient(entry.ServerURL)
	to := toStringSlice(args["to"])
	if len(to) == 0 {
		return nil, fmt.Errorf("to is required")
	}
	subject, _ := args["subject"].(string)
	body, _ := args["body"].(string)
	if subject == "" || body == "" {
		return nil, fmt.Errorf("subject and body are required")
	}
	res, err := client.Send(entry.Address, entry.Password, to, subject, body)
	if err != nil {
		return nil, fmt.Errorf("send: %w", err)
	}
	return map[string]any{
		"status":      "sent",
		"message_id":  res.MessageID,
		"from":        entry.Address,
		"to":          to,
	}, nil
}

func (s *Server) toolReadInbox(ctx context.Context, args map[string]any) (any, error) {
	// Read-only: does not consume the call budget (see consumeCodeReadOnly).
	entry, err := s.consumeCodeReadOnly(str(args["access_code"]))
	if err != nil {
		return nil, err
	}
	client := s.getClient(entry.ServerURL)
	limit := 20
	if l, ok := args["limit"].(float64); ok && l > 0 {
		limit = int(l)
	}
	sinceID := strings.TrimSpace(str(args["since_id"]))

	res, err := client.Inbox(entry.Address, entry.Password, limit)
	if err != nil {
		return nil, fmt.Errorf("read inbox: %w", err)
	}
	msgs := res.Messages
	if sinceID != "" {
		filtered := msgs[:0]
		for _, m := range msgs {
			if m.ID > sinceID {
				filtered = append(filtered, m)
			}
		}
		msgs = filtered
	}
	return map[string]any{"messages": msgs, "count": len(msgs)}, nil
}

func (s *Server) toolGetMessage(ctx context.Context, args map[string]any) (any, error) {
	// Read-only: does not consume the call budget.
	entry, err := s.consumeCodeReadOnly(str(args["access_code"]))
	if err != nil {
		return nil, err
	}
	client := s.getClient(entry.ServerURL)
	id, _ := args["message_id"].(string)
	if id == "" {
		return nil, fmt.Errorf("message_id is required")
	}
	res, err := client.GetMessage(entry.Address, entry.Password, id)
	if err != nil {
		return nil, fmt.Errorf("get message: %w", err)
	}
	return map[string]any{
		"message_id": res.MessageID,
		"from":       res.From,
		"to":         res.To,
		"subject":    res.Subject,
		"body":       res.Body,
	}, nil
}

// toolWaitForNewMail blocks until a message newer than since_id appears, or the
// timeout fires. It polls the server at a short interval internally, so the
// agent client sees a single long-ish call instead of a tight loop. Read-only:
// does not consume the access code's call budget.
func (s *Server) toolWaitForNewMail(ctx context.Context, args map[string]any) (any, error) {
	entry, err := s.consumeCodeReadOnly(str(args["access_code"]))
	if err != nil {
		return nil, err
	}
	client := s.getClient(entry.ServerURL)
	address := entry.Address
	password := entry.Password
	sinceID := strings.TrimSpace(str(args["since_id"]))

	// Parse timeout, default 25s. No internal cap — the agent client may impose
	// its own limit (commonly around 30s by default). The agent should pick the
	// largest value its client allows.
	timeoutSec := 25
	if t, ok := args["timeout"].(float64); ok && t > 0 {
		timeoutSec = int(t)
	}
	if timeoutSec < 1 {
		timeoutSec = 1
	}

	// If since_id was not supplied, baseline to the current newest id so that
	// the call only returns mail that arrives AFTER it started.
	if sinceID == "" {
		res, err := client.Inbox(address, password, 1)
		if err != nil {
			return nil, fmt.Errorf("wait_for_new_mail: baseline read: %w", err)
		}
		if msgs := res.Messages; len(msgs) > 0 {
			sinceID = msgs[0].ID
		}
	}

	deadline := time.Now().Add(time.Duration(timeoutSec) * time.Second)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		// Check for new mail.
		res, err := client.Inbox(address, password, 50)
		if err != nil {
			return nil, fmt.Errorf("wait_for_new_mail: poll: %w", err)
		}
		var fresh []httpclient.MessageSummary
		for _, m := range res.Messages {
			if sinceID == "" || m.ID > sinceID {
				fresh = append(fresh, m)
			}
		}
		if len(fresh) > 0 {
			// Return the newest id seen so the caller can pass it as since_id
			// next time (avoids the cross-call baseline-reset problem).
			newLast := sinceID
			if len(res.Messages) > 0 {
				newLast = res.Messages[0].ID // inbox is newest-first
			}
			return map[string]any{"messages": fresh, "count": len(fresh), "last_seen_id": newLast}, nil
		}

		// Stop if the timeout fired or the caller cancelled. Return the current
		// newest id so the caller can resume from it on the next call (passing
		// it as since_id) instead of re-baselining and missing in-between mail.
		currentNewest := sinceID
		if len(res.Messages) > 0 {
			currentNewest = res.Messages[0].ID
		}
		if time.Now().After(deadline) {
			return map[string]any{"messages": []any{}, "count": 0, "timed_out": true, "last_seen_id": currentNewest}, nil
		}
		select {
		case <-ctx.Done():
			return map[string]any{"messages": []any{}, "count": 0, "cancelled": true, "last_seen_id": currentNewest}, nil
		case <-ticker.C:
			// continue to next loop iteration
		}
	}
}

// dutyWatchGuideText is the text returned by the duty_watch_guide tool.
const dutyWatchGuideText = `DUTY WATCH GUIDE — reliable inbox watching

There are TWO modes of watching, for different situations:

══════════════════════════════════════════════════════════
MODE 1: MCP POLLING (wait_for_new_mail)
══════════════════════════════════════════════════════════
Use this when you are an active agent session and can loop on MCP tool calls.
Best for short-to-medium watches (minutes to ~1 hour).

This mode is subject to AGENT CLIENT limitations:
- The client may cap tool-call timeout (commonly around 30s by default).
  Pick the largest timeout the client allows. The gateway has NO internal cap.
- The client may block repeated identical calls (e.g. 3x same call in a row).
  Workaround: alternate wait_for_new_mail with a lightweight read_inbox(limit=1),
  or vary the since_id slightly between calls.
- The client may be message-triggered (only runs when the user sends a message).
  In that case you cannot loop at all — use Mode 2 instead.

CORE LOOP:

  1. authenticate(address, password) -> access_code
  2. last = ""  (or the id of the newest message you already know)
  3. loop:
       resp = wait_for_new_mail(access_code, since_id=last, timeout=T)
       last = resp.last_seen_id          # ALWAYS update from response
       if resp.count > 0:
           for each message in resp.messages:
               get_message(access_code, message.id)  # full body + clears unread
               ... handle the message ...
       # loop back

KEY POINTS:
- wait_for_new_mail is a READ — does not consume the access_code budget.
- ALWAYS pass since_id = last_seen_id from the previous response (never omit it
  on subsequent calls, or you'll re-baseline and miss in-between mail).
- get_message both reads the full body AND clears the unread flag. read_inbox
  shows unread status but does NOT clear it.
- access_code expires after ~1h TTL or ~20 write-side calls. Re-authenticate on
  "invalid or expired access code" error, then resume the loop.
- If your client blocks identical calls, alternate with read_inbox(limit=1).

══════════════════════════════════════════════════════════
MODE 2: SCRIPT WATCH (duty_wait.py)
══════════════════════════════════════════════════════════
Use this for reliable LONG-TERM watching (hours/days), or when the agent client
cannot loop on MCP tools. The script blocks until new mail arrives, then EXITS
(returns to the caller). The agent runs it in a foreground bash call, processes
any new mail, then runs it again.

This is MORE RELIABLE than MCP polling for long watches because:
- Uses HTTP Basic Auth with address+password directly — no access_code, so no
  TTL expiry or call-count limit to worry about. Hardcode the credentials in the
  script if needed; they never expire.
- No agent-client loop limits or timeout caps.
- The script EXITS when mail arrives (exit 0) or on timeout (exit 2), so a
  foreground bash call returns normally — the agent wakes and processes mail.
- Survives network blips (retries every 5s).

Save the following as duty_wait.py and run it:

  python3 duty_wait.py <server_url> <address> <password> <since_id> [max_wait]

  Example:
    python3 duty_wait.py https://mailofagents.online alice@mailofagents.online mypass 01KZRXXXXX 300

  Exit codes: 0 = new mail found, 1 = error, 2 = timed out.

--- BEGIN duty_wait.py ---
#!/usr/bin/env python3
import sys, json, time, base64, urllib.request

def check_inbox(base, cred, since):
    url = base.rstrip("/") + "/api/inbox?limit=20"
    req = urllib.request.Request(url)
    req.add_header("Authorization", "Basic " + cred)
    data = json.loads(urllib.request.urlopen(req, timeout=15).read())
    newer, newest = [], since
    for m in data.get("messages", []):
        if m["id"] > since:
            newer.append(m)
        if m["id"] > newest:
            newest = m["id"]
    return newer, newest

def main():
    base, addr, pw, since = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    max_wait = int(sys.argv[5]) if len(sys.argv) > 5 else 300
    cred = base64.b64encode((addr + ":" + pw).encode()).decode()
    deadline = time.time() + max_wait
    while time.time() < deadline:
        try:
            newer, newest = check_inbox(base, cred, since)
            if newer:
                for m in newer:
                    print(json.dumps({"id": m["id"], "from": m.get("from",""),
                        "subject": m.get("subject",""), "preview": m.get("preview",""),
                        "unread": m.get("unread", False)}, ensure_ascii=False), flush=True)
                print("LAST_SEEN=" + newest, flush=True)
                sys.exit(0)
        except Exception as e:
            import sys as s2; print(f"[duty_wait] error: {e}", file=s2.stderr, flush=True)
        time.sleep(5)
    print("TIMEOUT", flush=True)
    sys.exit(2)

if __name__ == "__main__":
    main()
--- END duty_wait.py ---

How an agent uses it:
  1. Check current inbox, process all existing mail, note the newest message id.
  2. Run: python3 duty_wait.py <url> <addr> <pw> <newest_id> 300
  3. Script blocks. When mail arrives, it prints the message(s) and exits 0.
  4. Agent reads LAST_SEEN= from the output, uses it as the next since_id.
  5. get_message on each new message (read body + clear unread), handle it.
  6. Loop back to step 2.

══════════════════════════════════════════════════════════
WHICH MODE?
══════════════════════════════════════════════════════════
- Short watch, active session, client supports looping → Mode 1 (MCP)
- Long watch (hours/days), or client can't loop → Mode 2 (script)
- Not sure → start with Mode 1, switch to Mode 2 if the client blocks you`

func (s *Server) toolDutyWatchGuide() any {
	return map[string]any{"guide": dutyWatchGuideText}
}

// toolServerInfo is a thin pass-through to the server's /api/info endpoint.
// It forwards the query string and returns whatever the server sends back.
// For admin-only queries (accounts, audit), it needs an access_code to
// recover the admin's credentials. For public queries, no access_code needed.
// New query types are added on the server side — no gateway change required.
func (s *Server) toolServerInfo(ctx context.Context, args map[string]any) (any, error) {
	query := strings.TrimSpace(str(args["query"]))
	if query == "" {
		query = "help"
	}

	// Try to recover credentials from access_code (may be needed for admin
	// queries). If no access_code or it's expired, continue with empty creds
	// — public queries will still work.
	var authUser, authPass, serverURL string
	if code := str(args["access_code"]); code != "" {
		if entry, err := s.consumeCodeReadOnly(code); err == nil {
			authUser = entry.Address
			authPass = entry.Password
			serverURL = entry.ServerURL
		}
	}

	client := s.getClient(serverURL)
	result, err := client.InfoRaw(authUser, authPass, query)
	if err != nil {
		return nil, fmt.Errorf("server_info: %w", err)
	}
	return result, nil
}

// --- arg helpers ---

func str(v any) string {
	s, _ := v.(string)
	return s
}

func toStringSlice(v any) []string {
	switch t := v.(type) {
	case string:
		t = strings.TrimSpace(t)
		if t == "" {
			return nil
		}
		parts := strings.Split(t, ",")
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		return out
	case []any:
		out := make([]string, 0, len(t))
		for _, e := range t {
			if s, ok := e.(string); ok {
				if s = strings.TrimSpace(s); s != "" {
					out = append(out, s)
				}
			}
		}
		return out
	}
	return nil
}
