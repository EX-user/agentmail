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
			Description: "Register a new mail account with a semantic identity. Returns the account address and a generated password. Store the password in session memory; you'll need it to authenticate.",
			InputSchema: schemaObject(map[string]any{
				"name": prop("ASCII local-part, e.g. 'frontend-engineer-1'", "string", true),
			}, []string{"name"}),
		},
		{
			Name:        "authenticate",
			Description: "Exchange address + password for a short-lived access code. The code is used by send_email/read_inbox/get_message and expires after a limited time or number of calls.",
			InputSchema: schemaObject(map[string]any{
				"address":  prop("Account address, e.g. 'frontend-engineer-1@agentmail.local'", "string", true),
				"password": prop("Account password from register", "string", true),
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
			Description: "Block until at least one new message arrives in the account's inbox, or until the timeout elapses (whichever comes first). 'New' means strictly newer than since_id (by ULID time order). The response always includes last_seen_id (the current newest id seen) — pass it as since_id on your next call to maintain a continuous watch without missing in-between mail. If since_id is omitted on the first call, baseline = current newest id. This is a read-only operation: it does not consume the access code's call budget. Use timeout ≤ 25 to respect typical agent-client tool-call limits (e.g. opencode defaults to 30s).",
			InputSchema: schemaObject(map[string]any{
				"access_code": prop("Access code from authenticate", "string", true),
				"since_id":    prop("Only return messages with id strictly greater than this. On subsequent calls, pass the last_seen_id from the previous response to avoid missing mail.", "string", false),
				"timeout":     prop("Max seconds to block waiting (default 25, capped at 60). Returns whatever has arrived when the timeout fires.", "integer", false),
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
	res, err := s.client.Register(name)
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
	address = strings.TrimSpace(address)
	if address == "" || password == "" {
		return nil, fmt.Errorf("address and password are required")
	}
	code, err := s.issueCode(ctx, address, password)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"access_code": code,
		"hint":        "Use this for send_email/read_inbox/get_message. If a later call fails with 'invalid or expired access code', call authenticate again.",
	}, nil
}

func (s *Server) toolSend(ctx context.Context, args map[string]any) (any, error) {
	address, password, err := s.consumeCode(str(args["access_code"]))
	if err != nil {
		return nil, err
	}
	to := toStringSlice(args["to"])
	if len(to) == 0 {
		return nil, fmt.Errorf("to is required")
	}
	subject, _ := args["subject"].(string)
	body, _ := args["body"].(string)
	if subject == "" || body == "" {
		return nil, fmt.Errorf("subject and body are required")
	}
	res, err := s.client.Send(address, password, to, subject, body)
	if err != nil {
		return nil, fmt.Errorf("send: %w", err)
	}
	return map[string]any{
		"status":      "sent",
		"message_id":  res.MessageID,
		"from":        address,
		"to":          to,
	}, nil
}

func (s *Server) toolReadInbox(ctx context.Context, args map[string]any) (any, error) {
	// Read-only: does not consume the call budget (see consumeCodeReadOnly).
	address, password, err := s.consumeCodeReadOnly(str(args["access_code"]))
	if err != nil {
		return nil, err
	}
	limit := 20
	if l, ok := args["limit"].(float64); ok && l > 0 {
		limit = int(l)
	}
	sinceID := strings.TrimSpace(str(args["since_id"]))

	// Fetch a reasonable window, then optionally filter by since_id. ULIDs are
	// time-ordered Crockford-Base32 strings, so lexicographic compare == time
	// compare. We fetch up to `limit` and keep only those strictly greater than
	// since_id; if the caller polls frequently a small limit suffices.
	res, err := s.client.Inbox(address, password, limit)
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
	address, password, err := s.consumeCodeReadOnly(str(args["access_code"]))
	if err != nil {
		return nil, err
	}
	id, _ := args["message_id"].(string)
	if id == "" {
		return nil, fmt.Errorf("message_id is required")
	}
	res, err := s.client.GetMessage(address, password, id)
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
	address, password, err := s.consumeCodeReadOnly(str(args["access_code"]))
	if err != nil {
		return nil, err
	}
	sinceID := strings.TrimSpace(str(args["since_id"]))

	// Parse timeout, default 25s, cap at 60s. Beyond 60s risks the MCP client
	// (opencode/codex) timing out the whole tool call.
	timeoutSec := 25
	if t, ok := args["timeout"].(float64); ok && t > 0 {
		timeoutSec = int(t)
	}
	if timeoutSec > 60 {
		timeoutSec = 60
	}

	// If since_id was not supplied, baseline to the current newest id so that
	// the call only returns mail that arrives AFTER it started.
	if sinceID == "" {
		res, err := s.client.Inbox(address, password, 1)
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
		res, err := s.client.Inbox(address, password, 50)
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
