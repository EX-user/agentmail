package server

import (
	"net/http"

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
	out, err := s.store.MgmtSubsOverview(me)
	if err != nil {
		internalError(w, "mgmt overview: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}
