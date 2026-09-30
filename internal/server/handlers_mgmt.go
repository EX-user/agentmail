package server

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/agentmail/agentmail/internal/audit"
)

// Management endpoints (v0.6, contract finalized 2026-08-24).
//
//   GET /api/mgmt/subs-overview  (auth=self)
//     -> {window_days, subs:[...], graph:{nodes,edges}}
//
// Derives from subordinate read-only visible data (no new visibility
// surface). Empty state is 200 with empty arrays — never an error. The
// subordinate-mailbox scan is sampled-audited like the other sub-read
// paths (first read per (superior, subordinate) pair per hour).

// handleMgmtSubsOverview returns the merged subordinate overview + graph.
func (s *Server) handleMgmtSubsOverview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	me := accountFrom(r.Context())
	// Sampled audit for each subordinate mailbox this scan touches.
	for _, e := range s.store.SubordinatesOf(me) {
		if s.store.ShouldAuditSubRead(me, e.Address) {
			_ = s.audit.Record(r.Context(), audit.ActionSubRead, me,
				"sub-read target="+e.Address+" via=mgmt-overview")
		}
	}
	// Range selector (superior request): ?days=7|30|0 — 0 = all time.
	// Anything invalid (or negative) falls back to the default 7d window.
	days := 7
	if v := strings.TrimSpace(r.URL.Query().Get("days")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 && n <= 365 {
			days = n
		}
	}
	out, err := s.store.MgmtSubsOverviewWindow(me, days)
	if err != nil {
		internalError(w, "mgmt overview: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleMgmtContactLatests returns the accounts-page latest-message line
// data for NON-subordinate rows (bug fix 09-29 via boss: contact rows with
// real correspondence showed the no-mail placeholder - the 0.3.3-C latest
// generation never ran for them). Pure correspondence drive: an address
// appears iff it exchanged mail with the login account; visibility plays
// no part.
//
//	GET /api/mgmt/contacts-latest (auth=self)
//	  -> {"contacts":[{address, latest_subject, latest_at}...], "count":N}
func (s *Server) handleMgmtContactLatests(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	me := accountFrom(r.Context())
	list, err := s.store.MgmtContactLatests(me)
	if err != nil {
		internalError(w, "contacts latest: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"contacts": list, "count": len(list)})
}

// handleMgmtUnreadBySender returns the accounts-page unread-dot data
// (0.3.4 item 1): per sender with unread mail in the login account's own
// inbox, the unread count. Self data only - no subordinate scan.
//
//	GET /api/mgmt/unread-by-sender (auth=self)
//	  -> {"by_sender": {"addr": n, ...}, "count": N}
func (s *Server) handleMgmtUnreadBySender(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	me := accountFrom(r.Context())
	by, err := s.store.UnreadBySender(me)
	if err != nil {
		internalError(w, "unread by sender: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"by_sender": by, "count": len(by)})
}
