package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/agentmail/agentmail/internal/audit"
	"github.com/agentmail/agentmail/internal/store"
)

// handleHealthz is a plain liveness probe (no auth).
func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// handleStatus reports initialization state (no auth). Used by the panel to
// decide whether to show the setup wizard or the normal UI.
//   GET /api/status -> {"initialized": bool, "domain": "..."}
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"initialized": s.store.IsInitialized(),
		"domain":      s.domain(),
		"version":     Version,
	})
}

// handleSetup performs first-time initialization. Only works when the system
// is NOT yet initialized; after that it returns 409. Creates the admin
// account, stores the domain, and marks the system initialized.
//   POST /setup {"admin_password": "...", "domain": "..."}
//   -> {"admin_address": "..."}
func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if s.store.IsInitialized() {
		http.Error(w, "already initialized", http.StatusConflict)
		return
	}
	var body struct {
		AdminPassword string `json:"admin_password"`
		Domain        string `json:"domain"`
		AdminLocalPart string `json:"admin_local_part"` // optional, default "admin"
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "invalid body: "+err.Error())
		return
	}
	if len(body.AdminPassword) < 8 {
		badRequest(w, "admin_password must be at least 8 characters")
		return
	}
	domain := strings.TrimSpace(body.Domain)
	if domain == "" {
		badRequest(w, "domain is required")
		return
	}
	if !isASCIIDomain(domain) {
		badRequest(w, "domain must be ASCII letters, digits, '.', or '-'")
		return
	}
	adminLocal := strings.TrimSpace(body.AdminLocalPart)
	if adminLocal == "" {
		adminLocal = "admin"
	}
	if !isASCIILocalPart(adminLocal) {
		badRequest(w, "admin_local_part must be ASCII letters/digits/-/_")
		return
	}

	if err := s.store.BootstrapSystem(adminLocal, body.AdminPassword, domain); err != nil {
		internalError(w, "bootstrap: "+err.Error())
		return
	}
	_ = s.audit.Record(r.Context(), audit.ActionRegister, adminLocal+"@"+domain, "bootstrap admin")
	writeJSON(w, http.StatusOK, map[string]any{
		"admin_address": adminLocal + "@" + domain,
	})
}

// handleRegister creates a new account from a semantic name.
//   POST /api/register  {"name": "frontend-engineer-1"}
//   -> {"address": "...", "password": "..."}
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.store.IsRegistrationEnabled() {
		http.Error(w, "registration disabled", http.StatusForbidden)
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "invalid body: "+err.Error())
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		badRequest(w, "name is required")
		return
	}
	if !isASCIILocalPart(name) {
		badRequest(w, "name must be ASCII letters, digits, '-' or '_'")
		return
	}

	res, err := s.store.CreateAccount(name, s.domain(), false)
	if err != nil {
		if errors.Is(err, store.ErrAccountExists) {
			conflict(w, "account already exists")
			return
		}
		internalError(w, "create account: "+err.Error())
		return
	}
	_ = s.audit.Record(r.Context(), audit.ActionRegister, res.Address, "name="+name)
	writeJSON(w, http.StatusOK, map[string]any{
		"address":  res.Address,
		"password": res.Password,
	})
}

// handleVerifyPassword checks a credential pair.
//   POST /api/verify-password  {"address": "...", "password": "..."}
//   -> {"ok": true} or 401
func (s *Server) handleVerifyPassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		Address  string `json:"address"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "invalid body: "+err.Error())
		return
	}
	if err := s.store.VerifyPassword(body.Address, body.Password); err != nil {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleSend posts a message from the authenticated account.
//   POST /api/send  {"to": [...], "subject": "...", "body": "..."}
//   -> {"message_id": "..."}
func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	from := accountFrom(r.Context())
	var body struct {
		To      []string `json:"to"`
		Subject string   `json:"subject"`
		Body    string   `json:"body"`
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "invalid body: "+err.Error())
		return
	}
	if len(body.To) == 0 {
		badRequest(w, "to is required")
		return
	}
	if body.Subject == "" || body.Body == "" {
		badRequest(w, "subject and body are required")
		return
	}

	// Send rate limit (per-sender).
	if err := s.checkSendRate(from); err != nil {
		http.Error(w, err.Error(), http.StatusTooManyRequests)
		return
	}

	// Byte receive rate limit (per-recipient): filter out recipients whose
	// hourly byte budget would be exceeded.
	bodyLen := int64(len(body.Body))
	var validRecipients []string
	for _, rcpt := range body.To {
		if s.checkRecvRate(rcpt, bodyLen) {
			validRecipients = append(validRecipients, rcpt)
		}
	}
	if len(validRecipients) == 0 {
		http.Error(w, "all recipients exceeded byte rate limit", http.StatusTooManyRequests)
		return
	}

	fromName := localPart(from)
	res, err := s.store.Send(from, fromName, validRecipients, body.Subject, body.Body)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	_ = s.audit.Record(r.Context(), audit.ActionSend, from,
		fmt.Sprintf("to=%s subj_len=%d", strings.Join(body.To, ","), len(body.Subject)))
	writeJSON(w, http.StatusOK, map[string]any{
		"message_id": res.MessageID,
		"status":     "sent",
	})
}

// handleInbox lists the authenticated account's inbox.
//   GET /api/inbox?limit=20  -> {"messages": [...], "count": N}
func (s *Server) handleInbox(w http.ResponseWriter, r *http.Request) {
	who := accountFrom(r.Context())
	limit := queryInt(r, "limit", 20)
	msgs, err := s.store.ReadInbox(who, limit)
	if err != nil {
		internalError(w, "read inbox: "+err.Error())
		return
	}
	_ = s.audit.Record(r.Context(), audit.ActionReadInbox, who, fmt.Sprintf("count=%d", len(msgs)))
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs, "count": len(msgs)})
}

// handleMessage fetches one message by id, if the authenticated account can
// see it (inbox or sent).
//   GET /api/message?id=...  -> {"message_id","from","to","subject","body","received_at"}
func (s *Server) handleMessage(w http.ResponseWriter, r *http.Request) {
	who := accountFrom(r.Context())
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		badRequest(w, "id is required")
		return
	}
	msg, err := s.store.GetMessage(who, id)
	if err != nil {
		if errors.Is(err, store.ErrMessageNotFound) || errors.Is(err, store.ErrAccountNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		internalError(w, "get message: "+err.Error())
		return
	}
	_ = s.audit.Record(r.Context(), audit.ActionGetMessage, who, "id="+id)
	writeJSON(w, http.StatusOK, map[string]any{
		"message_id":  msg.ID,
		"from":        msg.From,
		"to":          msg.To,
		"subject":     msg.Subject,
		"body":        msg.Body,
		"received_at": msg.ReceivedAt,
	})
}

// handleProfileSelf updates the authenticated account's directory visibility
// and signature. Uses account Basic auth (like handleSend).
//   GET  /api/profile/self  -> {"address","visible","signature"}
//   POST /api/profile/self  {"visible": bool, "signature": string}
//   -> {"ok": true, "visible": bool, "signature": string}
//
// signature is trimmed and capped at 200 characters (MaxSignatureLen).
func (s *Server) handleProfileSelf(w http.ResponseWriter, r *http.Request) {
	who := accountFrom(r.Context())
	if r.Method == http.MethodGet {
		acc, err := s.store.GetAccount(who)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"address":   acc.Address,
			"visible":   acc.Visible,
			"signature": acc.Signature,
		})
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		Visible   bool   `json:"visible"`
		Signature string `json:"signature"`
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "invalid body: "+err.Error())
		return
	}
	sig := strings.TrimSpace(body.Signature)
	if len(sig) > MaxSignatureLen {
		badRequest(w, fmt.Sprintf("signature too long (max %d chars)", MaxSignatureLen))
		return
	}
	// Global guard: if the admin has disabled directory listing, block the
	// false→true transition. Existing listed accounts stay listed (true→true
	// is allowed), and anyone can un-list themselves (→false). Only opting IN
	// is refused.
	if body.Visible && !s.store.IsDirectoryListedEnabled() {
		cur, err := s.store.GetAccount(who)
		if err != nil || !cur.Visible {
			http.Error(w, "directory listing is disabled", http.StatusForbidden)
			return
		}
	}
	if err := s.store.UpdateProfile(who, body.Visible, sig); err != nil {
		internalError(w, "update profile: "+err.Error())
		return
	}
	_ = s.audit.Record(r.Context(), audit.ActionProfileUpdate, who,
		fmt.Sprintf("visible=%v sig_len=%d", body.Visible, len(sig)))
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"visible":   body.Visible,
		"signature": sig,
	})
}

// handleAccountInfo is the account-scoped query endpoint. It requires account
// Basic auth (requireAccount) — every query needs access, so the tool contract
// is uniform. This is the account-level companion to /api/info (which is
// system-level): directory moves here from server_info so MCP tools split by
// responsibility (system info vs account info vs self-update).
//   GET /api/account/info?query=self       -> {address, visible, signature}
//   GET /api/account/info?query=directory  -> {entries:[{address, signature}]}
//
// query=directory reuses ListVisibleAccounts (same data as the public
// /api/info?query=directory); it is exposed here too so the account_info MCP
// tool is self-contained.
func (s *Server) handleAccountInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	who := accountFrom(r.Context())
	query := strings.TrimSpace(r.URL.Query().Get("query"))
	if query == "" {
		query = "self"
	}
	switch query {
	case "self":
		acc, err := s.store.GetAccount(who)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"query":     "self",
			"address":   acc.Address,
			"visible":   acc.Visible,
			"signature": acc.Signature,
		})

	case "directory":
		visible, err := s.store.ListVisibleAccounts()
		if err != nil {
			internalError(w, "list visible: "+err.Error())
			return
		}
		type dirEntry struct {
			Address   string `json:"address"`
			Signature string `json:"signature"`
		}
		entries := make([]dirEntry, 0, len(visible))
		for _, a := range visible {
			entries = append(entries, dirEntry{Address: a.Address, Signature: a.Signature})
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"query":   "directory",
			"count":   len(entries),
			"entries": entries,
		})

	default:
		badRequest(w, "unknown query: "+query+". Use query=self or query=directory.")
	}
}

// --- response helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func decodeJSON(r *http.Request, v any) error {
	return json.NewDecoder(r.Body).Decode(v)
}

func badRequest(w http.ResponseWriter, msg string)  { http.Error(w, msg, http.StatusBadRequest) }
func conflict(w http.ResponseWriter, msg string)    { http.Error(w, msg, http.StatusConflict) }
func internalError(w http.ResponseWriter, msg string) { http.Error(w, msg, http.StatusInternalServerError) }
func methodNotAllowed(w http.ResponseWriter)         { http.Error(w, "method not allowed", http.StatusMethodNotAllowed) }

func queryInt(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	var n int
	if _, err := fmt.Sscanf(v, "%d", &n); err != nil || n <= 0 {
		return def
	}
	return n
}

func localPart(addr string) string {
	if at := strings.IndexByte(addr, '@'); at > 0 {
		return addr[:at]
	}
	return addr
}

// isASCIILocalPart accepts [a-zA-Z0-9_-]+.
func isASCIILocalPart(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// isASCIIDomain accepts a dot-separated domain like "agentmail.local" or
// "mail.example.com". Each label is [a-zA-Z0-9-]+. No underscores (DNS
// hostnames don't allow them, though some systems tolerate them).
func isASCIIDomain(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-':
		default:
			return false
		}
	}
	// Reject leading/trailing dot or dash, and empty labels (..).
	if s[0] == '.' || s[0] == '-' || s[len(s)-1] == '.' || s[len(s)-1] == '-' {
		return false
	}
	if strings.Contains(s, "..") {
		return false
	}
	return true
}
