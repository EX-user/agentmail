package server

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/agentmail/agentmail/internal/audit"
	"github.com/agentmail/agentmail/internal/store"
)

// accountView is the admin-facing projection of an account: the password hash
// is stripped so it can never leak via the API.
type accountView struct {
	UUID      string `json:"uuid"`
	Address   string `json:"address"`
	IsAdmin   bool   `json:"is_admin"`
	Disabled  bool   `json:"disabled"`
	CreatedAt int64  `json:"created_at"`
}

// handleAdminMessages lets the admin read any account's inbox.
//   GET /admin/messages?account=<addr>&limit=50
//   -> {"account": "...", "messages": [...], "count": N}
func (s *Server) handleAdminMessages(w http.ResponseWriter, r *http.Request) {
	account := strings.TrimSpace(r.URL.Query().Get("account"))
	if account == "" {
		badRequest(w, "account query parameter required")
		return
	}
	limit := queryInt(r, "limit", 50)
	// admin viewing another's inbox: show the OWNER's unread state (so admin can
	// see whether the owner has read these messages), not admin's own (which
	// would always be "read" since admin isn't a recipient).
	msgs, err := s.store.ReadInbox(account, limit)
	if err != nil {
		if errors.Is(err, store.ErrAccountNotFound) {
			http.Error(w, "account not found", http.StatusNotFound)
			return
		}
		internalError(w, "read inbox: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"account":  account,
		"messages": msgs,
		"count":    len(msgs),
	})
}

// handleAdminAudit returns recent audit entries.
//   GET /admin/audit?limit=100  -> {"entries": [...], "count": N}
func (s *Server) handleAdminAudit(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 100)
	entries, err := s.audit.List(r.Context(), limit)
	if err != nil {
		internalError(w, "audit list: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries, "count": len(entries)})
}

// handleAdminAccounts lists every account WITHOUT password hashes.
//   GET /admin/accounts  -> {"accounts": [...], "count": N}
func (s *Server) handleAdminAccounts(w http.ResponseWriter, r *http.Request) {
	accs, err := s.store.ListAccounts()
	if err != nil {
		internalError(w, "list accounts: "+err.Error())
		return
	}
	out := make([]accountView, 0, len(accs))
	for _, a := range accs {
		out = append(out, accountView{
			UUID:      a.UUID,
			Address:   a.Address,
			IsAdmin:   a.IsAdmin,
			Disabled:  a.Disabled,
			CreatedAt: a.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": out, "count": len(out)})
}

// handleAdminSent lets the admin read any account's sent folder.
//   GET /admin/sent?account=<addr>&limit=50
//   -> {"account": "...", "messages": [...], "count": N}
func (s *Server) handleAdminSent(w http.ResponseWriter, r *http.Request) {
	account := strings.TrimSpace(r.URL.Query().Get("account"))
	if account == "" {
		badRequest(w, "account query parameter required")
		return
	}
	limit := queryInt(r, "limit", 50)
	msgs, err := s.store.ReadSent(account, limit)
	if err != nil {
		if errors.Is(err, store.ErrAccountNotFound) {
			http.Error(w, "account not found", http.StatusNotFound)
			return
		}
		internalError(w, "read sent: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"account":  account,
		"messages": msgs,
		"count":    len(msgs),
	})
}

// handleAdminMessage returns the full body of any message by ID, bypassing the
// per-account visibility check (the admin can read anything).
//   GET /admin/message?id=...  -> {"id","from","to","subject","body","received_at"}
func (s *Server) handleAdminMessage(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		badRequest(w, "id is required")
		return
	}
	msg, err := s.store.GetMessageAdmin(id)
	if err != nil {
		if errors.Is(err, store.ErrMessageNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		internalError(w, "get message: "+err.Error())
		return
	}
	// If the admin is an actual recipient of this message, mark it read for
	// the admin (so the admin's own inbox unread state stays accurate). When
	// the admin is merely viewing someone else's mail, do NOT mutate state.
	for _, rcpt := range msg.To {
		if rcpt == s.cfg.Admin.Address {
			if acc, err := s.store.GetAccount(s.cfg.Admin.Address); err == nil {
				_ = s.store.MarkRead(acc.UUID, id)
			}
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":          msg.ID,
		"from":        msg.From,
		"to":          msg.To,
		"subject":     msg.Subject,
		"body":        msg.Body,
		"received_at": msg.ReceivedAt,
	})
}

// handleAdminStats returns overall counts for the overview page.
//   GET /admin/stats  -> {"accounts": N, "messages": N}
func (s *Server) handleAdminStats(w http.ResponseWriter, r *http.Request) {
	accN, err := s.store.CountAccounts()
	if err != nil {
		internalError(w, "count accounts: "+err.Error())
		return
	}
	msgN, err := s.store.CountMessages()
	if err != nil {
		internalError(w, "count messages: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": accN, "messages": msgN})
}

// handleAdminResetPassword sets a new password for any account (the admin's
// own included). The new password is returned in plaintext exactly once so the
// admin can hand it to the account owner.
//
//	POST /admin/reset-password  {"account": "<addr>", "new_password": "<optional>"}
//	  -> {"account": "...", "password": "<the new plaintext password>"}
//
// If new_password is omitted or empty, a random 24-char password is generated.
// A supplied new_password must be at least 8 chars. The old password is NOT
// verified (the admin has already authenticated).
func (s *Server) handleAdminResetPassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		Account    string `json:"account"`
		NewPassword string `json:"new_password"`
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "invalid body: "+err.Error())
		return
	}
	account := strings.TrimSpace(body.Account)
	if account == "" {
		badRequest(w, "account is required")
		return
	}

	password := strings.TrimSpace(body.NewPassword)
	if password == "" {
		// Generate a random one when the admin did not supply one.
		password = store.GeneratePassword(24)
	} else if len(password) < 8 {
		badRequest(w, "new_password must be at least 8 characters")
		return
	}

	if err := s.store.ResetPassword(account, password); err != nil {
		if errors.Is(err, store.ErrAccountNotFound) {
			http.Error(w, "account not found", http.StatusNotFound)
			return
		}
		internalError(w, "reset password: "+err.Error())
		return
	}
	detail := "by=admin"
	if strings.TrimSpace(body.NewPassword) == "" {
		detail += " random=true"
	} else {
		detail += " random=false"
	}
	_ = s.audit.Record(r.Context(), audit.ActionResetPassword, account, detail)
	writeJSON(w, http.StatusOK, map[string]any{
		"account":  account,
		"password": password,
	})
}

// handleAdminSetDisabled toggles an account's disabled flag. A disabled account
// cannot authenticate (so it can neither send nor read mail), but the account
// and its message history persist. The admin cannot disable itself (lockout
// guard). Reversible by calling with disabled=false.
//
//	POST /admin/set-disabled  {"account": "<addr>", "disabled": true|false}
//	  -> {"account": "...", "disabled": bool}
func (s *Server) handleAdminSetDisabled(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		Account  string `json:"account"`
		Disabled bool   `json:"disabled"`
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "invalid body: " + err.Error())
		return
	}
	account := strings.TrimSpace(body.Account)
	if account == "" {
		badRequest(w, "account is required")
		return
	}
	// Lockout guard: the admin cannot disable itself.
	if account == s.cfg.Admin.Address && body.Disabled {
		badRequest(w, "cannot disable your own admin account")
		return
	}
	if err := s.store.SetAccountDisabled(account, body.Disabled); err != nil {
		if errors.Is(err, store.ErrAccountNotFound) {
			http.Error(w, "account not found", http.StatusNotFound)
			return
		}
		internalError(w, "set disabled: " + err.Error())
		return
	}
	state := "enable"
	if body.Disabled {
		state = "disable"
	}
	_ = s.audit.Record(r.Context(), audit.ActionDisableAccount, account, "by=admin "+state)
	writeJSON(w, http.StatusOK, map[string]any{
		"account":  account,
		"disabled": body.Disabled,
	})
}

// handleAdminSend lets the admin send mail as the admin account. The from
// address is forced to the configured admin address (the admin cannot spoof
// another sender), so the admin speaks only as itself.
//
//	POST /admin/send  {"to": [...], "subject": "...", "body": "..."}
//	  -> {"message_id": "...", "status": "sent"}
func (s *Server) handleAdminSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
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

	from := s.cfg.Admin.Address
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
