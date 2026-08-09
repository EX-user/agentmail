// Package gateway is the agentmail MCP gateway. It is a stdio subprocess that
// an agent client spawns per session. It holds NO persistent data — its only
// state is an in-memory map of access codes to credentials, which dies with
// the process. Every mailbox operation is forwarded to agentmail-server over
// HTTP using the credentials recovered from the access code.
//
// Lifecycle: the agent client spawns this binary once per session; it serves
// JSON-RPC on stdin/stdout until the pipe closes (session end), then exits.
// One subprocess == one session. When it exits, all its access codes vanish.
package gateway

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"github.com/agentmail/agentmail/internal/httpclient"
)

// CodeTTL is how long an access code stays valid.
var CodeTTL = time.Hour

// CodeMaxCalls is how many tool calls one access code may serve.
var CodeMaxCalls = 20

// Server is the gateway: MCP transport + access-code map + HTTP client.
type Server struct {
	client *httpclient.Client

	mu    sync.Mutex
	codes map[string]*codeEntry // access_code plaintext -> entry

	in  *bufio.Reader
	out io.Writer
}

// codeEntry is the in-memory record for one access code.
type codeEntry struct {
	Address   string
	Password  string
	ExpiresAt time.Time
	CallsUsed int
	MaxCalls  int
}

// New returns a gateway talking to the server at baseURL, reading MCP from
// stdin and writing to stdout.
func New(baseURL string) *Server {
	return &Server{
		client: httpclient.New(baseURL),
		codes:  make(map[string]*codeEntry),
		in:     bufio.NewReader(os.Stdin),
		out:    os.Stdout,
	}
}

// Serve runs the JSON-RPC loop until stdin closes.
func (s *Server) Serve(ctx context.Context) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		line, err := s.in.ReadBytes('\n')
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if isEmpty(line) {
			continue
		}
		s.handle(ctx, line)
	}
}

// --- access code management (gateway-local, in-memory) ---

// issueCode verifies credentials with the server and, on success, mints a
// short-lived access code bound to them.
func (s *Server) issueCode(ctx context.Context, address, password string) (string, error) {
	if err := s.client.VerifyPassword(address, password); err != nil {
		return "", fmt.Errorf("authentication failed: %w", err)
	}
	code, err := randomCode(32)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.codes[code] = &codeEntry{
		Address:   address,
		Password:  password,
		ExpiresAt: time.Now().Add(CodeTTL),
		CallsUsed: 0,
		MaxCalls:  CodeMaxCalls,
	}
	s.mu.Unlock()
	return code, nil
}

// consumeCode validates a code, returns the bound credentials, and consumes
// one call against the per-code call budget. Used for operations with side
// effects (register, authenticate, send_email). Returns ErrInvalidCode if the
// code is unknown, expired, or exhausted.
func (s *Server) consumeCode(code string) (address, password string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.codes[code]
	if !ok {
		return "", "", ErrInvalidCode
	}
	if time.Now().After(e.ExpiresAt) {
		delete(s.codes, code)
		return "", "", ErrInvalidCode
	}
	if e.CallsUsed >= e.MaxCalls {
		delete(s.codes, code)
		return "", "", ErrInvalidCode
	}
	e.CallsUsed++
	return e.Address, e.Password, nil
}

// consumeCodeReadOnly validates a code and returns the bound credentials
// WITHOUT consuming a call against the budget. Used for read-only operations
// (read_inbox, get_message). The TTL still applies — a read-only call on an
// expired code still fails — but reads do not exhaust the 20-call budget.
//
// Rationale: per-account isolation (enforced by the server via Basic auth)
// already guarantees that a read only ever touches the code owner's own mail,
// so the blast radius of an over-used code on reads is negligible. Counting
// reads would force long-polling/watching agents to burn their entire budget
// in minutes, defeating the access code's role as a session credential. The
// TTL (1h) remains the time-bound protection.
func (s *Server) consumeCodeReadOnly(code string) (address, password string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.codes[code]
	if !ok {
		return "", "", ErrInvalidCode
	}
	if time.Now().After(e.ExpiresAt) {
		delete(s.codes, code)
		return "", "", ErrInvalidCode
	}
	return e.Address, e.Password, nil
}

// ErrInvalidCode signals an unknown, expired, or exhausted access code.
var ErrInvalidCode = errors.New("invalid or expired access code")

// randomCode returns a hex-encoded random string of n bytes.
func randomCode(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func isEmpty(line []byte) bool {
	for _, b := range line {
		if b != ' ' && b != '\t' && b != '\n' && b != '\r' {
			return false
		}
	}
	return true
}

// --- MCP JSON-RPC transport ---

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

const (
	codeParseError     = -32700
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
)

func (s *Server) handle(ctx context.Context, raw []byte) {
	var req rpcRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		s.respond(rpcResponse{JSONRPC: "2.0", Error: &rpcError{Code: codeParseError, Message: "parse error"}})
		return
	}
	isNotification := len(req.ID) == 0
	switch req.Method {
	case "initialize":
		s.respond(s.handleInitialize(req))
	case "notifications/initialized":
		// no-op; notifications get no reply
	case "tools/list":
		s.respond(s.handleToolsList(req))
	case "tools/call":
		s.respond(s.handleToolsCall(ctx, req))
	case "ping":
		s.respond(rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{}})
	default:
		if !isNotification {
			s.respond(rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: codeMethodNotFound, Message: "method not found: " + req.Method}})
		}
	}
}

func (s *Server) handleInitialize(req rpcRequest) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{"tools": map[string]any{}},
		"serverInfo":      map[string]any{"name": "agentmail", "version": "0.1.0"},
		"instructions":    agentmailInstructions,
	}}
}

// agentmailInstructions is the server-level guidance returned during the MCP
// initialize handshake. Clients surface it to the agent so a fresh session
// knows what agentmail is and the typical flow, without having to infer it
// from individual tool descriptions.
const agentmailInstructions = `agentmail is a local mail system that lets AI agents exchange messages using persistent identities (name@agentmail.local). You operate as one account.

Typical flow:
1. If you already have credentials (address + password), call authenticate to get an access_code.
2. Use the access_code with send_email / read_inbox / get_message / wait_for_new_mail.
3. The access_code is session-scoped: it expires after ~1h (TTL) or 20 write-side calls. Reads (read_inbox / get_message / wait_for_new_mail) do NOT count against the budget, so you can poll freely.
4. If an access_code stops working, call authenticate again with the same credentials to mint a new one.

If you do NOT have credentials, you can either call register(name) to create an account yourself (the endpoint is open; pick a clear ASCII name like "frontend-engineer-1"), or ask the admin to register one for you. Admin registration is preferred in shared/production environments to avoid account sprawl; self-registration is fine for personal/testing use.

Operating mode:
agentmail is a tool you pick up when needed — like any other tool. Most sessions use it occasionally: send a message, check for a reply, move on. Do NOT autonomously enter a polling/watch loop. Only watch the inbox continuously when the user has explicitly asked you to do so. Otherwise, do your current task and stop normally; the mailbox will still be there next time you need it.

When you ARE watching (user asked you to):
- wait_for_new_mail is a read, so it does not consume the access_code call budget; you can call it repeatedly within the 1h TTL. Use timeout ≤ 25s to respect typical agent-client tool-call limits (e.g. opencode defaults to 30s).
- For token efficiency over long quiet stretches, interleave with bash sleep (e.g. "sleep 300" = 5 min, zero token cost). Keep any single sleep ≤ 1h so you wake before the access_code TTL expires; re-authenticate if it has.
- If your client cannot loop on MCP tools (e.g. user-message-triggered clients), fall back to a background HTTP polling script that wakes you on new mail.

Worked example (two agents exchanging mail):
  authenticate(address="alice@agentmail.local", password="...")  -> access_code
  send_email(access_code, to="bob@agentmail.local", subject="hi", body="hello")
  read_inbox(access_code, limit=10)                                -> see replies
  get_message(access_code, message_id="...")                       -> full body`

func (s *Server) respond(resp rpcResponse) {
	if len(resp.ID) == 0 {
		return // notification
	}
	out, err := json.Marshal(resp)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintln(s.out, string(out))
}
