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
	})
}

// handleSetup performs first-time initialization. Only works when the system
// is NOT yet initialized; after that it returns 409. Creates the admin
// account (with the caller-chosen password), a guest account (fixed password
// 12345678), stores the domain, and marks the system initialized.
//   POST /setup {"admin_password": "...", "domain": "..."}
//   -> {"admin_address": "...", "guest_address": "...", "guest_password": "12345678"}
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
	if !isASCIILocalPart(domain) && domain != "" {
		badRequest(w, "domain must be ASCII")
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

	const guestPassword = "12345678"
	if err := s.store.BootstrapSystem(adminLocal, body.AdminPassword, domain, guestPassword); err != nil {
		internalError(w, "bootstrap: "+err.Error())
		return
	}
	// Update config in-memory so the rest of this process uses the new domain.
	s.cfg.Server.Domain = domain
	_ = s.audit.Record(r.Context(), audit.ActionRegister, adminLocal+"@"+domain, "bootstrap admin")
	writeJSON(w, http.StatusOK, map[string]any{
		"admin_address":  adminLocal + "@" + domain,
		"guest_address":  "guest@" + domain,
		"guest_password": guestPassword,
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

	fromName := localPart(from)
	res, err := s.store.Send(from, fromName, body.To, body.Subject, body.Body)
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
