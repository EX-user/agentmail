package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

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
		"initialized":                  s.store.IsInitialized(),
		"domain":                       s.domain(),
		"version":                      Version,
		"suggested_min_gateway_version": SuggestedMinGatewayVersion,
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
	// Per-IP throttle: the portal offers friction-free registration, so
	// scripted mass creation (and name-probing) needs a stopper. Attempts
	// count even when they fail, and the threshold is admin-tunable.
	if !s.regLimit.allow(clientIP(r), s.store.GetRegisterIPRateLimit(), time.Now()) {
		http.Error(w, "too many registrations from this address, try again later", http.StatusTooManyRequests)
		return
	}
	var body struct {
		Name     string `json:"name"`
		Password string `json:"password"` // optional: use the caller-chosen password
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

	// Optional caller-chosen password: when present it must meet the same
	// minimum as everywhere else, and the response omits it (the caller
	// already knows it — the field's absence is the frontend's branch
	// signal). Absent/empty keeps the generated one-time password flow
	// (one-click register depends on it).
	chosePassword := strings.TrimSpace(body.Password) != ""
	var res *store.CreateAccountResult
	var err error
	if chosePassword {
		if len(body.Password) < store.MinPasswordLength {
			badRequest(w, fmt.Sprintf("password must be at least %d chars", store.MinPasswordLength))
			return
		}
		res, err = s.store.CreateAccountWithPassword(name, s.domain(), false, body.Password)
	} else {
		res, err = s.store.CreateAccount(name, s.domain(), false)
	}
	if err != nil {
		if errors.Is(err, store.ErrAccountExists) {
			conflict(w, "account already exists")
			return
		}
		internalError(w, "create account: "+err.Error())
		return
	}
	_ = s.audit.Record(r.Context(), audit.ActionRegister, res.Address,
		"name="+name+" chose_password="+fmt.Sprint(chosePassword))
	resp := map[string]any{
		"address": res.Address,
	}
	if !chosePassword {
		resp["password"] = res.Password
	}
	writeJSON(w, http.StatusOK, resp)
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
//   POST /api/send  {"to": [...], "subject": "...", "body": "...", "public": bool, "attachments": ["fileID", ...]}
//   -> {"message_id": "..."}
// public (optional, default false) additionally writes an independent copy
// to the showcase bucket for the public portal sample — explicit opt-in by
// the sender; delivery is unaffected either way.
// attachments (optional) references files the sender previously uploaded;
// the server validates ownership, embeds the download metadata into the
// message, and grants the recipients download access in the same
// transaction.
func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	from := accountFrom(r.Context())
	var body struct {
		To          []string `json:"to"`
		CC          []string `json:"cc"`
		Subject     string   `json:"subject"`
		Body        string   `json:"body"`
		Public      bool     `json:"public"`
		Attachments []string `json:"attachments"`
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
	// hourly byte budget would be exceeded. CC recipients count the same way.
	bodyLen := int64(len(body.Body))
	var validRecipients []string
	for _, rcpt := range append(append([]string{}, body.To...), body.CC...) {
		if s.checkRecvRate(rcpt, bodyLen) {
			validRecipients = append(validRecipients, rcpt)
		}
	}
	if len(validRecipients) == 0 {
		http.Error(w, "all recipients exceeded byte rate limit", http.StatusTooManyRequests)
		return
	}

	fromName := localPart(from)
	var res *store.SendResult
	var err error
	if len(body.Attachments) > 0 {
		// Attachments must reference the sender's own uploaded files; the
		// store validates ownership and grants recipients download access.
		res, err = s.store.SendWithAttachments(from, fromName, body.To, body.CC, body.Subject, body.Body, body.Attachments)
	} else {
		res, err = s.store.Send(from, fromName, body.To, body.CC, body.Subject, body.Body)
	}
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	// Showcase tee: explicit sender opt-in. Best-effort — a tee failure must
	// not fail the (successful) send. (showcase_enabled only hides the
	// Compose checkbox UI; API public sends are not gated by it.)
	if body.Public {
		if err := s.store.TeeShowcase(from, body.To, body.Subject, body.Body); err != nil {
			fmt.Printf("showcase tee failed (send %s still delivered): %v\n", res.MessageID, err)
		}
	}
	_ = s.audit.Record(r.Context(), audit.ActionSend, from,
		fmt.Sprintf("to=%s subj_len=%d public=%v", strings.Join(body.To, ","), len(body.Subject), body.Public))
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
	offset := queryInt(r, "offset", 0)
	msgs, err := s.store.ReadInboxPaged(who, limit, offset)
	if err != nil {
		internalError(w, "read inbox: "+err.Error())
		return
	}
	// unread_count must reflect the WHOLE inbox, not the current page —
	// the nav badge reads it and must not depend on limit/offset.
	unread, _ := s.store.CountUnread(who)
	total, _ := s.store.CountInbox(who)
	_ = s.audit.Record(r.Context(), audit.ActionReadInbox, who, fmt.Sprintf("count=%d unread=%d total=%d", len(msgs), unread, total))
	writeJSON(w, http.StatusOK, map[string]any{
		"messages":     msgs,
		"count":        len(msgs),
		"unread_count": unread,
		"total_count":  total,
	})
}

// handleInboxMarkAllRead clears every unread marker in the caller's inbox.
//   POST /api/inbox/mark-all-read (no body) -> {"marked": N}
// The panel's bulk-dismiss button uses it; the badge drops to zero on the
// next poll.
func (s *Server) handleInboxMarkAllRead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	who := accountFrom(r.Context())
	n, err := s.store.MarkAllRead(who)
	if err != nil {
		internalError(w, "mark all read: "+err.Error())
		return
	}
	_ = s.audit.Record(r.Context(), audit.ActionReadInbox, who, fmt.Sprintf("mark-all-read cleared=%d", n))
	writeJSON(w, http.StatusOK, map[string]any{"marked": n})
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
	resp := map[string]any{
		"message_id":  msg.ID,
		"from":        msg.From,
		"to":          msg.To,
		"subject":     msg.Subject,
		"body":        msg.Body,
		"received_at": msg.ReceivedAt,
	}
	if len(msg.CC) > 0 {
		resp["cc"] = msg.CC
	}
	// Attachments carry the download metadata (id/filename/size/access
	// code + expires_at) the recipient needs. Omit the key entirely when
	// there are none (matches the stored message shape).
	if len(msg.Attachments) > 0 {
		type attOut struct {
			store.AttachmentMeta
			ExpiresAt int64 `json:"expires_at"`
		}
		out := make([]attOut, 0, len(msg.Attachments))
		for _, a := range msg.Attachments {
			out = append(out, attOut{AttachmentMeta: a, ExpiresAt: s.store.AttachmentExpiresAt(a)})
		}
		resp["attachments"] = out
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleThread returns the bilateral conversation between the authenticated
// account and one peer, newest first.
//   GET /api/thread?with=<address>&limit=50&offset=0
//     -> {"peer","messages":[{...MessageSummary, "dir":"in"|"out"}],"count"}
func (s *Server) handleThread(w http.ResponseWriter, r *http.Request) {
	who := accountFrom(r.Context())
	peer := strings.TrimSpace(r.URL.Query().Get("with"))
	if peer == "" {
		badRequest(w, "with is required")
		return
	}
	limit := queryInt(r, "limit", 50)
	offset := queryInt(r, "offset", 0)
	entries, err := s.store.ReadThread(who, peer, limit, offset)
	if err != nil {
		if errors.Is(err, store.ErrAccountNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		internalError(w, "read thread: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"peer":     peer,
		"messages": entries,
		"count":    len(entries),
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
			"address":         acc.Address,
			"visible":         acc.Visible,
			"signature":       acc.Signature,
			"files_used_bytes": s.store.AccountFilesUsed(acc.Address),
			"prefs":           acc.Prefs,
		})
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		Visible   *bool            `json:"visible"` // nil = keep current (omitting must NOT reset)
		Signature string           `json:"signature"`
		Prefs     *map[string]any  `json:"prefs"` // nil = keep current; keys whitelist-validated below
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
	// Resolve visible: an omitted field keeps the stored value (the old
	// non-pointer bool decoded "absent" to false and silently un-listed
	// accounts that only meant to update their signature).
	cur, err := s.store.GetAccount(who)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	visible := cur.Visible
	if body.Visible != nil {
		visible = *body.Visible
	}
	// Global guard: if the admin has disabled directory listing, block the
	// false→true transition. Existing listed accounts stay listed (true→true
	// is allowed), and anyone can un-list themselves (→false). Only opting IN
	// is refused.
	if body.Visible != nil && *body.Visible && !s.store.IsDirectoryListedEnabled() {
		if !cur.Visible {
			http.Error(w, "directory listing is disabled", http.StatusForbidden)
			return
		}
	}
	if err := s.store.UpdateProfile(who, visible, sig); err != nil {
		internalError(w, "update profile: "+err.Error())
		return
	}
	_ = s.audit.Record(r.Context(), audit.ActionProfileUpdate, who,
		fmt.Sprintf("visible=%v sig_len=%d", body.Visible, len(sig)))
	// Preference keys: a closed whitelist per preference page v1. Unknown
	// keys are rejected so the map can never become a junk drawer.
	if body.Prefs != nil {
		validKeys := map[string]bool{"audio_autoplay": true, "image_preview": true}
		for k, v := range *body.Prefs {
			if !validKeys[k] {
				badRequest(w, "unknown pref key: "+k)
				return
			}
			if _, ok := v.(bool); v != nil && !ok {
				badRequest(w, "pref "+k+" must be a boolean (or null to remove)")
				return
			}
		}
		if err := s.store.UpdatePrefs(who, *body.Prefs); err != nil {
			internalError(w, "update prefs: "+err.Error())
			return
		}
	}
	acc2, err := s.store.GetAccount(who)
	if err != nil {
		internalError(w, "reload profile: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"visible":   body.Visible,
		"signature": sig,
		"prefs":     acc2.Prefs,
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
			"query":           "self",
			"address":         acc.Address,
			"is_admin":        acc.IsAdmin,
			"visible":         acc.Visible,
			"signature":       acc.Signature,
			"files_used_bytes": s.store.AccountFilesUsed(acc.Address),
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

// handleContacts returns the deduplicated list of addresses the authenticated
// account has exchanged mail with (inbox senders + sent recipients, excluding
// self). Account Basic auth. Used by the regular-user panel's Accounts tab and
// the Compose "to" dropdown.
//   GET /api/contacts  -> {"contacts": ["a@...", "b@..."], "count": N}
func (s *Server) handleContacts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	who := accountFrom(r.Context())
	contacts, err := s.store.ListContacts(who)
	if err != nil {
		internalError(w, "list contacts: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"contacts": contacts, "count": len(contacts)})
}

// handleSent lists the authenticated account's sent messages.
//   GET /api/sent?limit=50  -> {"messages": [...], "count": N, "total_count": T}
// total_count is the full sent count regardless of the page limit (mirrors
// /api/inbox; the My-activity cards request limit=1 and read total_count).
func (s *Server) handleSent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	who := accountFrom(r.Context())
	limit := queryInt(r, "limit", 50)
	msgs, err := s.store.ReadSent(who, limit)
	if err != nil {
		internalError(w, "read sent: "+err.Error())
		return
	}
	total, _ := s.store.CountSent(who)
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs, "count": len(msgs), "total_count": total})
}

// handleMyGrowth returns the authenticated account's recent in/out activity
// (today/week scalars + a 7-day array). Account-authenticated — this is
// personal data, deliberately NOT under public /api/info.
//   GET /api/mygrowth -> {"today_in","today_out","week_in","week_out","days":[...]}
func (s *Server) handleMyGrowth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	who := accountFrom(r.Context())
	g, err := s.store.MyGrowthStats(who, time.Now())
	if err != nil {
		internalError(w, "my growth: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// handleChangePassword lets the authenticated account change its own password
// by proving the old password. Account Basic auth.
//   POST /api/password {"old_password":"...","new_password":"..."} -> {"ok":true}
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	who := accountFrom(r.Context())
	var body struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "invalid body: "+err.Error())
		return
	}
	if err := s.store.ChangePassword(who, body.OldPassword, body.NewPassword); err != nil {
		if errors.Is(err, store.ErrWrongPassword) {
			http.Error(w, "wrong password", http.StatusUnauthorized)
			return
		}
		if errors.Is(err, store.ErrAccountNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		badRequest(w, err.Error())
		return
	}
	_ = s.audit.Record(r.Context(), audit.ActionRegister, who, "self password change")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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

// handleRegisterTeam provisions an owner account plus its subordinate bot
// accounts in one atomic transaction — the guest portal's "register for an
// AI team" entry (superior-approved contract).
//   POST /api/register-team {"username","password","team_size"}
//   -> {"owner":{"address","password"},"members":[...]}   (one-time)
// team_size 1-10 (default 3) counts MEMBERS ONLY — the owner account is
// extra (architect ruling: 3 = 1 owner + 3 members); per-IP throttle
// 4/hour; audit register_team.
func (s *Server) handleRegisterTeam(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.regLimit.allow(clientIP(r), 4, time.Now()) {
		http.Error(w, "too many registrations from this address, try again later", http.StatusTooManyRequests)
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		TeamSize int    `json:"team_size"`
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "invalid body: "+err.Error())
		return
	}
	name := strings.TrimSpace(body.Username)
	if name == "" || !isASCIILocalPart(name) {
		badRequest(w, "username must be ASCII letters, digits, '-' or '_'")
		return
	}
	if len(body.Password) < store.MinPasswordLength {
		badRequest(w, fmt.Sprintf("password must be at least %d chars", store.MinPasswordLength))
		return
	}
	size := body.TeamSize
	if size == 0 {
		size = 3
	}
	if size < 1 || size > 10 {
		badRequest(w, "team_size must be 1-10")
		return
	}
	owner, members, err := s.store.RegisterTeam(name, s.domain(), body.Password, size)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	_ = s.audit.Record(r.Context(), audit.ActionRegisterTeam, owner.Address,
		fmt.Sprintf("team_size=%d members=%d", size, len(*members)))
	writeJSON(w, http.StatusCreated, map[string]any{
		"owner":   owner,
		"members": members,
	})
}
