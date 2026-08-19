package server

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/agentmail/agentmail/internal/audit"
	"github.com/agentmail/agentmail/internal/store"
)

// Subordinate-account API (v1). A (the authenticated account) declares
// itself a subordinate of B; B can then read A's inbox+sent (scope is a
// reserved field, v1 always "both"). Self-declared, revocable, queries
// never recurse. 404 masquerade: unauthorized relationship reads look
// identical to "no such account" so existence of a relationship is not
// leaked.
//
//   POST   /api/subs              {"superior": "b@x", "scope": "both"}   (auth = A)
//   DELETE /api/subs?superior=...                                          (auth = A)
//   GET    /api/subs                                                        (auth = caller: own edges both ways)
//   GET    /api/subs/{A}/messages?folder=inbox|sent|both&limit=            (auth = B)

// declareRateLimit is the per-account hourly cap on declare calls (anti
// spamming of relationship edges; revokes are free).
const declareRateLimit = 10

// handleSubs dispatches /api/subs by method: GET = list own edges,
// POST = declare, DELETE = revoke.
func (s *Server) handleSubs(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleSubsList(w, r)
	case http.MethodPost:
		s.handleSubsDeclare(w, r)
	case http.MethodDelete:
		s.handleSubsRevoke(w, r)
	default:
		methodNotAllowed(w)
	}
}

// handleSubsList returns the caller's own edges: subordinates (who declared
// under me) and superiors (who I declared under).
func (s *Server) handleSubsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	me := accountFrom(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		"subordinates": s.store.SubordinatesOf(me),
		"superiors":    s.store.SuperiorsOf(me),
	})
}

// handleSubsDeclare declares the authenticated account (A) a subordinate of
// body.superior (B). Idempotent; audited.
func (s *Server) handleSubsDeclare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	me := accountFrom(r.Context())
	var body struct {
		Superior string `json:"superior"`
		Scope    string `json:"scope"`
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "invalid body: "+err.Error())
		return
	}
	if strings.TrimSpace(body.Superior) == "" {
		badRequest(w, "superior is required")
		return
	}
	// Scope field is reserved: v1 only accepts "both" (or omitted).
	if body.Scope != "" && body.Scope != "both" {
		badRequest(w, "scope values other than \"both\" are not supported in v1")
		return
	}
	// Anti-spam: cap declares per account per hour.
	s.rateMu.Lock()
	now := time.Now()
	rw := s.declareRates[me]
	if rw == nil || now.Sub(rw.windowStart) >= time.Hour {
		rw = &rateWindow{windowStart: now}
		s.declareRates[me] = rw
	}
	if rw.count >= declareRateLimit {
		s.rateMu.Unlock()
		http.Error(w, fmt.Sprintf("declare rate limit exceeded (%d/hour)", declareRateLimit), http.StatusTooManyRequests)
		return
	}
	rw.count++
	s.rateMu.Unlock()

	if err := s.store.DeclareSubordinate(body.Superior, me); err != nil {
		if err == store.ErrNoSuchAccount {
			http.Error(w, "no such account", http.StatusNotFound)
			return
		}
		badRequest(w, err.Error())
		return
	}
	_ = s.audit.Record(r.Context(), audit.ActionSubDeclare, me, "declare-sub superior="+body.Superior)
	writeJSON(w, http.StatusCreated, map[string]any{
		"status":    "declared",
		"superior":  body.Superior,
		"scope":     "both",
	})
}

// handleSubsRevoke removes the authenticated account's (A's) declaration
// under the given superior (B). Idempotent; audited. Takes effect on the
// very next read (no caching).
func (s *Server) handleSubsRevoke(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		methodNotAllowed(w)
		return
	}
	me := accountFrom(r.Context())
	superior := strings.TrimSpace(r.URL.Query().Get("superior"))
	if superior == "" {
		badRequest(w, "superior query parameter is required")
		return
	}
	if err := s.store.RevokeSubordinate(superior, me); err != nil {
		badRequest(w, err.Error())
		return
	}
	_ = s.audit.Record(r.Context(), audit.ActionSubRevoke, me, "revoke-sub superior="+superior)
	writeJSON(w, http.StatusOK, map[string]any{"status": "revoked", "superior": superior})
}

// handleSubsMessages lets B (authenticated) read A's messages. Authorization
// is checked first and failures masquerade as 404 so the existence of a
// relationship is never leaked. Attachment access codes are stripped (Q2
// ruling: metadata only — download requires A's explicit grant).
func (s *Server) handleSubsMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	me := accountFrom(r.Context())
	// Path: /api/subs/{A}/messages (list) or /api/subs/{A}/message (detail).
	segs := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(segs) != 4 || (segs[3] != "messages" && segs[3] != "message") {
		http.NotFound(w, r)
		return
	}
	target := segs[2]

	// Self-read: the flat "all visible accounts" view may address the
	// caller's OWN mailbox through this uniform path. That must behave
	// exactly like /api/message — including clearing the unread marker
	// (subordinate reads deliberately never touch A's read state, which
	// made the own-inbox badge stuck when the panel routed self-reads
	// here) — and must not require a self-relationship (which 404'd).
	if strings.EqualFold(me, target) {
		if segs[3] == "message" {
			id := strings.TrimSpace(r.URL.Query().Get("id"))
			if id == "" {
				badRequest(w, "id query parameter is required")
				return
			}
			msg, err := s.store.GetMessage(me, id) // normal semantics: visibility + MarkRead
			if err != nil {
				http.NotFound(w, r)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"subordinate": target,
				"message":     *msg, // own mailbox: attachment codes visible, nothing stripped
			})
			return
		}
		folder := r.URL.Query().Get("folder")
		if folder == "" {
			folder = "both"
		}
		limit := 50
		if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 && l <= 200 {
			limit = l
		}
		msgs, err := s.store.ReadSubordinateMessages(me, folder, limit)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"subordinate": target,
			"folder":      folder,
			"count":       len(msgs),
			"messages":    msgs,
		})
		return
	}

	// The masquerade: no relationship and no account look identical.
	if !s.store.IsSubordinate(me, target) {
		http.NotFound(w, r)
		return
	}

	// Detail: GET /api/subs/{A}/message?id=<messageID> — full body, cc
	// included, attachment access codes stripped (Q2: metadata only).
	if segs[3] == "message" {
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			badRequest(w, "id query parameter is required")
			return
		}
		if s.store.ShouldAuditSubRead(me, target) {
			_ = s.audit.Record(r.Context(), audit.ActionSubRead, me, "sub-read target="+target)
		}
		msg, err := s.store.GetSubordinateMessage(id)
		if err != nil {
			http.NotFound(w, r) // same masquerade shape
			return
		}
		// The message must belong to the subordinate's view (their inbox or
		// sent reference) — otherwise B could fish arbitrary message ids.
		if !s.store.MessageReferencedBy(target, id) {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"subordinate": target,
			"message":     stripAttachmentCodes(*msg),
		})
		return
	}

	// Sampled audit: first read per (B,A) per hour is recorded.
	if s.store.ShouldAuditSubRead(me, target) {
		_ = s.audit.Record(r.Context(), audit.ActionSubRead, me, "sub-read target="+target)
	}

	folder := r.URL.Query().Get("folder")
	if folder == "" {
		folder = "both"
	}
	limit := 50
	if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 && l <= 200 {
		limit = l
	}
	msgs, err := s.store.ReadSubordinateMessages(target, folder, limit)
	if err != nil {
		http.NotFound(w, r) // target vanished mid-request — same masquerade
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"subordinate": target,
		"folder":      folder,
		"count":       len(msgs),
		"messages":    msgs,
	})
}

// stripAttachmentCodes returns a copy of the message with every
// attachment's access code removed — metadata only for the superior's view
// (Q2 ruling: download requires the subordinate's explicit grant).
func stripAttachmentCodes(m store.Message) store.Message {
	if len(m.Attachments) == 0 {
		return m
	}
	m.Attachments = append([]store.AttachmentMeta(nil), m.Attachments...)
	for i := range m.Attachments {
		m.Attachments[i].AccessCode = ""
	}
	return m
}
