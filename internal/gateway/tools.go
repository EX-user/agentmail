package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agentmail/agentmail/internal/httpclient"
)

// Text-attachment limits for send_email inline_files.
const (
	maxAttachFiles     = 3        // at most 3 files per send
	maxAttachFileBytes = 100 * 1024 // 100KB per file
	maxAttachTotal     = 200 * 1024 // 200KB across all files
)

// attachFiles reads each path (plain text, from the caller's own machine —
// the gateway runs wherever the agent runs, so this reads the agent's local
// files, not the server's) and appends a delimited block per file to body.
// The mail stays plain text; the server is unaware of attachments.
func attachFiles(body string, paths []string) (string, error) {
	if len(paths) == 0 {
		return body, nil
	}
	if len(paths) > maxAttachFiles {
		return "", fmt.Errorf("inline_files: at most %d files allowed, got %d", maxAttachFiles, len(paths))
	}
	var b strings.Builder
	b.WriteString(body)
	total := 0
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			return "", fmt.Errorf("inline_files: cannot read %q: %w", p, err)
		}
		if len(data) > maxAttachFileBytes {
			return "", fmt.Errorf("inline_files: %q is %d bytes, over the %d-byte per-file limit", p, len(data), maxAttachFileBytes)
		}
		total += len(data)
		if total > maxAttachTotal {
			return "", fmt.Errorf("inline_files: total %d bytes exceeds the %d-byte limit", total, maxAttachTotal)
		}
		b.WriteString("\n\n--- file: " + filepath.Base(p) + " ---\n")
		b.Write(data)
		b.WriteString("\n")
	}
	return b.String(), nil
}

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
			Description: "Send a plain-text email from the account bound to the access code. Set public=true to additionally publish a copy to the public showcase (portal sample) — an explicit opt-in; delivery is unaffected. inline_files (optional, 1-3 paths) reads plain-text files on the machine where the gateway runs and appends each as a delimited block at the end of the body (100KB per file, 200KB total) — inline text becomes part of the body and never expires. attachments (optional, 1-5 paths) uploads real attachments through the file store — recipients can download them via the codes embedded in the message (1MB per file); attachments are stored server-side with a 30-day TTL and storage caps, so for text you want preserved verbatim prefer inline_files.",
			InputSchema: schemaObject(map[string]any{
				"access_code": prop("Access code from authenticate", "string", true),
				"to":          arrayProp("Recipient address(es); a comma-separated string is also accepted", true),
				"cc":          arrayProp("Optional carbon-copy address(es), delivered like To and visible to all recipients of the message; a comma-separated string is also accepted", false),
				"subject":     prop("Subject line", "string", true),
				"body":        prop("Plain-text body", "string", true),
				"public":      prop("Also publish a copy to the public showcase (opt-in, default false)", "boolean", false),
				"inline_files": arrayProp("Optional inline text: 1-3 local file paths whose contents are appended to the body as '--- file: <name> ---' blocks (100KB/file, 200KB total); a comma-separated string is also accepted", false),
				"attachments": arrayProp("Optional real attachments: 1-5 local file paths uploaded via the file store; recipients receive download codes in the message (1MB/file); a comma-separated string is also accepted", false),
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
			Description: "Fetch the full body of a single message by id. Messages with files include an 'attachments' array [{id, filename, size, access_code}] — download each via the download_attachment tool or HTTP GET /api/files/{id}/download?code={access_code} (Basic auth).",
			InputSchema: schemaObject(map[string]any{
				"access_code": prop("Access code from authenticate", "string", true),
				"message_id":  prop("Message id from read_inbox", "string", true),
			}, []string{"access_code", "message_id"}),
		},
		{
			Name:        "download_attachment",
			Description: "Download one attachment by file id. Text files with valid UTF-8 content are returned inline; anything else (binary) comes back base64-encoded with a byte count. Files over 512KB are refused — fetch those via HTTP GET /api/files/{id}/download?code={code} instead. Requires the account to be the file owner or a recipient of the message that carried it (the access_code from that message's attachments entry must also match).",
			InputSchema: schemaObject(map[string]any{
				"access_code": prop("Access code from authenticate", "string", true),
				"file_id":     prop("File id from a message's attachments entry", "string", true),
				"code":        prop("The attachment's access_code from the same attachments entry", "string", true),
			}, []string{"access_code", "file_id", "code"}),
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
			Description: "Query the server for SYSTEM-level structured information. Pass query to select what to return: \"status\" (version/domain, plus this gateway's own gateway_version and the server's suggested_min_gateway_version — swap the gateway binary when gateway_version is older), \"stats\" (account/message counts), \"settings\" (registration/rate limits), \"accounts\" (full account list, admin only), \"audit\" (recent audit log, admin only), \"help\" (list all queries). Admin-only queries require access_code from an admin account. This tool covers system-wide info; for ACCOUNT-level queries (your own profile, the public directory) use account_info instead. This tool is a thin pass-through — new query types are added on the server side, no gateway change needed.",
			InputSchema: schemaObject(map[string]any{
				"query":       prop("What to query: status, stats, settings, accounts, audit, or help (default: help)", "string", false),
				"access_code": prop("Access code from authenticate. Required for admin-only queries (accounts, audit). Omit for public queries.", "string", false),
			}, []string{}),
		},
		{
			Name:        "account_info",
			Description: "Query ACCOUNT-level information for the account bound to the access code. Pass query to select what to return: \"self\" (your own profile: address, whether you are listed in the directory, and your signature) or \"directory\" (the public address book — every account that opted to be listed, with its signature). Always requires access_code (every query is account-scoped, for a uniform contract). Use this — not server_info — for your own profile or the directory.",
			InputSchema: schemaObject(map[string]any{
				"access_code": prop("Access code from authenticate (required — identifies whose profile / which account)", "string", true),
				"query":       prop("What to query: self (your own profile) or directory (public address book). Default: self.", "string", false),
			}, []string{"access_code"}),
		},
		{
			Name:        "update_profile",
			Description: "Update YOUR OWN directory profile: whether you are listed in the public address book (visible/listed) and your signature (a short tagline shown next to your address). Requires access_code to identify whose profile to change. The signature is trimmed and capped at 200 characters. Changes take effect immediately in account_info query=directory.",
			InputSchema: schemaObject(map[string]any{
				"access_code": prop("Access code from authenticate (required — identifies the account whose profile is updated)", "string", true),
				"visible":     prop("Whether to list this account in the public directory (true = listed, false = hidden)", "boolean", false),
				"signature":   prop("A short tagline shown next to the address in the directory (trimmed, max 200 chars)", "string", false),
			}, []string{"access_code"}),
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

// arrayProp declares a string-array parameter. Clients that strictly follow
// the schema rejected array inputs when these were declared "string" (three
// testers tripped on it); a comma-separated single string is still accepted
// by the tolerant parser.
func arrayProp(desc string, req bool) map[string]any {
	if req {
		desc += " (required)"
	}
	return map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": desc}
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
	case "download_attachment":
		result, err = s.toolDownloadAttachment(ctx, args)

	case "get_message":
		result, err = s.toolGetMessage(ctx, args)
	case "wait_for_new_mail":
		result, err = s.toolWaitForNewMail(ctx, args)
	case "duty_watch_guide":
		result = s.toolDutyWatchGuide()
	case "server_info":
		result, err = s.toolServerInfo(ctx, args)
	case "account_info":
		result, err = s.toolAccountInfo(ctx, args)
	case "update_profile":
		result, err = s.toolUpdateProfile(ctx, args)
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
	// cc (optional): carbon-copy addresses — delivered like To and visible
	// to all recipients of the message.
	cc := toStringSlice(args["cc"])
	subject, _ := args["subject"].(string)
	body, _ := args["body"].(string)
	if subject == "" || body == "" {
		return nil, fmt.Errorf("subject and body are required")
	}
	// inline_files (optional, 1-3): append plain-text file contents from the
	// machine where this gateway runs as delimited blocks after the body.
	// Validated (existence, per-file and total size) BEFORE consuming the
	// send, so a bad attachment never burns the access-code budget or sends
	// a truncated mail.
	attachPaths := toStringSlice(args["inline_files"])
	if len(attachPaths) > 0 {
		merged, err := attachFiles(body, attachPaths)
		if err != nil {
			return nil, err
		}
		body = merged
	}
	// attachments (optional, 1-5 local paths): true attachments via the
	// v0.5 file store. Each file is read (bounded), uploaded to the server
	// as the sender, and the returned IDs ride the send — the server
	// validates ownership and grants recipients download access. Uploads
	// happen BEFORE the send, so a mid-way failure sends nothing (any
	// already-uploaded orphans TTL out after 30 days).
	filePaths := toStringSlice(args["attachments"])
	var fileIDs []string
	if len(filePaths) > 0 {
		if len(filePaths) > 5 {
			return nil, fmt.Errorf("attachments: at most 5 files per send, got %d", len(filePaths))
		}
		for _, p := range filePaths {
			data, err := os.ReadFile(p)
			if err != nil {
				return nil, fmt.Errorf("attachments: cannot read %q: %w", p, err)
			}
			if int64(len(data)) > 1024*1024 {
				return nil, fmt.Errorf("attachments: %q is over the 1MB per-file limit", p)
			}
			up, err := client.UploadFile(entry.Address, entry.Password, filepath.Base(p), data)
			if err != nil {
				return nil, fmt.Errorf("attachments: upload %q: %w", p, err)
			}
			fileIDs = append(fileIDs, up.ID)
		}
	}
	// public (optional, default false): additionally publish a showcase copy
	// for the portal sample — the sender's explicit opt-in.
	public, _ := args["public"].(bool)
	res, err := client.Send(entry.Address, entry.Password, to, cc, subject, body, public, fileIDs)
	if err != nil {
		return nil, fmt.Errorf("send: %w", err)
	}
	return map[string]any{
		"status":      "sent",
		"message_id":  res.MessageID,
		"from":        entry.Address,
		"to":          to,
		"cc":          cc,
		"public":      public,
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

// toolDownloadAttachment fetches one attachment for the account bound to
// the access code. Valid-UTF-8 text is returned inline; binary comes back
// base64-encoded with a byte count. Over 512KB is refused (context-blowup
// guard — the caller is pointed at the HTTP endpoint instead).
func (s *Server) toolDownloadAttachment(ctx context.Context, args map[string]any) (any, error) {
	entry, err := s.consumeCodeReadOnly(str(args["access_code"]))
	if err != nil {
		return nil, err
	}
	client := s.getClient(entry.ServerURL)
	fileID := str(args["file_id"])
	code := str(args["code"])
	if fileID == "" || code == "" {
		return nil, fmt.Errorf("file_id and code are required")
	}
	content, filename, err := client.DownloadFile(entry.Address, entry.Password, fileID, code)
	if err != nil {
		return nil, fmt.Errorf("download_attachment: %w (check the file_id/access_code pair from the message's attachments entry)", err)
	}
	const maxInline = 512 * 1024
	if len(content) > maxInline {
		return nil, fmt.Errorf("download_attachment: %d bytes exceeds the 512KB inline limit — use HTTP GET /api/files/%s/download?code=%s with Basic auth instead", len(content), fileID, code)
	}
	if utf8.Valid(content) {
		return map[string]any{
			"file_id":  fileID,
			"filename": filename,
			"encoding": "utf-8",
			"bytes":    len(content),
			"content":  string(content),
		}, nil
	}
	return map[string]any{
		"file_id":  fileID,
		"filename": filename,
		"encoding": "base64",
		"bytes":    len(content),
		"content":  base64.StdEncoding.EncodeToString(content),
	}, nil
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
	resp := map[string]any{
		"message_id": res.MessageID,
		"from":       res.From,
		"to":         res.To,
		"subject":    res.Subject,
		"body":       res.Body,
	}
	// Attachments carry the download codes the recipient agent needs
	// (AC-1.4): GET /api/files/{id}/download?code=... with Basic auth.
	if len(res.Attachments) > 0 {
		resp["attachments"] = res.Attachments
	}
	return resp, nil
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
			// If the poll window was full, there may be MORE messages older
			// than the window but still newer than since_id — surface that
			// instead of silently skipping them.
			more := len(res.Messages) == 50
			return map[string]any{"messages": fresh, "count": len(fresh), "last_seen_id": newLast, "possibly_more": more}, nil
		}

		// Stop if the timeout fired or the caller cancelled. Return the
		// CALLER'S since_id unchanged: nothing was delivered, so the baseline
		// must not move. (The old code recomputed it from the inbox newest,
		// which can be OLDER than since_id — e.g. when since_id came from a
		// different ULID space — silently rewinding the caller's baseline.)
		if time.Now().After(deadline) {
			return map[string]any{"messages": []any{}, "count": 0, "timed_out": true, "last_seen_id": sinceID}, nil
		}
		select {
		case <-ctx.Done():
			return map[string]any{"messages": []any{}, "count": 0, "cancelled": true, "last_seen_id": sinceID}, nil
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
	// Augment the status query with the gateway's own version so callers can
	// compare gateway vs server in one response (server side reports
	// suggested_min_gateway_version; both halves of the pair are visible here).
	if query == "status" && result != nil {
		result["gateway_version"] = Version
	}
	return result, nil
}

// toolAccountInfo is the account-scoped query tool. Every query needs an
// access_code (uniform contract). query=self returns the caller's own profile;
// query=directory returns the public address book. Forwards to the server's
// /api/account/info endpoint.
func (s *Server) toolAccountInfo(ctx context.Context, args map[string]any) (any, error) {
	entry, err := s.consumeCodeReadOnly(str(args["access_code"]))
	if err != nil {
		return nil, err
	}
	query := strings.TrimSpace(str(args["query"]))
	if query == "" {
		query = "self"
	}
	if query != "self" && query != "directory" {
		return nil, fmt.Errorf("query must be 'self' or 'directory' (got %q)", query)
	}
	client := s.getClient(entry.ServerURL)
	result, err := client.AccountInfoRaw(entry.Address, entry.Password, query)
	if err != nil {
		return nil, fmt.Errorf("account_info: %w", err)
	}
	return result, nil
}

// toolUpdateProfile updates the caller's own directory profile (visibility +
// signature). Forwards to the server's POST /api/profile/self. The server does
// the trimming and 200-char cap; here we just pass the values through.
func (s *Server) toolUpdateProfile(ctx context.Context, args map[string]any) (any, error) {
	entry, err := s.consumeCode(str(args["access_code"]))
	if err != nil {
		return nil, err
	}
	// visible defaults to false if omitted; signature defaults to empty.
	visible := false
	if v, ok := args["visible"].(bool); ok {
		visible = v
	}
	signature, _ := args["signature"].(string)

	client := s.getClient(entry.ServerURL)
	result, err := client.UpdateProfile(entry.Address, entry.Password, visible, signature)
	if err != nil {
		return nil, fmt.Errorf("update_profile: %w", err)
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
