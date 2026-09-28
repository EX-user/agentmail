package store

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

// newMgmtStore opens a store and creates the accounts the fixtures use.
func newMgmtStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.db.Close() })
	for _, n := range []string{"me", "sub1", "sub2", "ext1", "ext2"} {
		if _, err := s.CreateAccount(n, "t", false); err != nil {
			t.Fatalf("create %s: %v", n, err)
		}
	}
	return s
}

// putMsg writes a message record directly (full control over ReceivedAt).
func putMsg(t *testing.T, s *Store, from string, to, cc []string, body string, at int64) {
	t.Helper()
	m := Message{ID: newULID(), From: from, To: to, CC: cc, Subject: "s", Body: body, ReceivedAt: at}
	val, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bMessages).Put([]byte(m.ID), val)
	}); err != nil {
		t.Fatalf("put msg: %v", err)
	}
}

func str(n int) string { return string(make([]rune, n)) }

// TestMgmtSubsOverviewAggregate pins the contract field by field: window
// counts vs all-time last_* averages, top contacts, graph nodes/edges with
// explicit directional counts, external top-3 selection.
func TestMgmtSubsOverviewAggregate(t *testing.T) {
	s := newMgmtStore(t)
	if err := s.DeclareSubordinate("me@t", "sub1@t"); err != nil {
		t.Fatalf("declare sub1: %v", err)
	}
	if err := s.DeclareSubordinate("me@t", "sub2@t"); err != nil {
		t.Fatalf("declare sub2: %v", err)
	}
	base := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC).Unix()
	w := base - 86400      // in 7d window
	old := base - 20*86400 // all-time only

	putMsg(t, s, "me@t", []string{"sub1@t"}, nil, str(100), w)  // me→sub1
	putMsg(t, s, "sub1@t", []string{"me@t"}, nil, str(50), w)   // sub1→me
	putMsg(t, s, "sub1@t", []string{"ext1@t"}, nil, str(10), w) // sub1→ext1
	putMsg(t, s, "sub1@t", []string{"ext1@t"}, nil, str(20), w) // sub1→ext1
	putMsg(t, s, "ext1@t", []string{"sub1@t"}, nil, str(5), w)  // ext1→sub1
	putMsg(t, s, "me@t", []string{"ext2@t"}, nil, str(30), w)   // me→ext2 (self external)
	putMsg(t, s, "me@t", []string{"sub2@t"}, nil, str(77), old) // me→sub2, all-time only

	s.now = func() time.Time { return time.Unix(base, 0).UTC() }
	out, err := s.MgmtSubsOverview("me@t")
	if err != nil {
		t.Fatalf("overview: %v", err)
	}
	if out.WindowDays != 7 {
		t.Errorf("window_days = %d, want 7", out.WindowDays)
	}
	if len(out.Subs) != 2 {
		t.Fatalf("len(subs) = %d, want 2", len(out.Subs))
	}
	sub1, sub2 := out.Subs[0], out.Subs[1]
	if sub1.Address != "sub1@t" || sub2.Address != "sub2@t" {
		t.Fatalf("sub order = %s,%s (want address asc)", sub1.Address, sub2.Address)
	}
	// sub1: in = me→sub1 + ext1→sub1 (2), out = sub1→me + 2×sub1→ext1 (3).
	if sub1.CountIn7d != 2 || sub1.CountOut7d != 3 {
		t.Errorf("sub1 counts = %d/%d, want 2/3", sub1.CountIn7d, sub1.CountOut7d)
	}
	if sub1.AvgLenIn != (100+5)/2 || sub1.AvgLenOut != (50+10+20)/3 {
		t.Errorf("sub1 avg = %d/%d, want 52/26", sub1.AvgLenIn, sub1.AvgLenOut)
	}
	if sub1.LastInAt != w || sub1.LastOutAt != w {
		t.Errorf("sub1 last = %d/%d, want %d", sub1.LastInAt, sub1.LastOutAt, w)
	}
	// sub1 top contacts: ext1 (3: 2 out + 1 in), me (1).
	if len(sub1.TopContacts) != 2 || sub1.TopContacts[0].Address != "ext1@t" || sub1.TopContacts[0].Count != 3 {
		t.Errorf("sub1 top = %+v, want ext1(3) first", sub1.TopContacts)
	}
	// sub2: only the 20-day-old inbound mail — all-time last, zero window.
	if sub2.LastInAt != old || sub2.LastOutAt != 0 {
		t.Errorf("sub2 last = %d/%d, want %d/0", sub2.LastInAt, sub2.LastOutAt, old)
	}
	if sub2.CountIn7d != 0 || sub2.CountOut7d != 0 || sub2.AvgLenIn != 0 {
		t.Errorf("sub2 window fields not zero: %+v", sub2)
	}
	if len(sub2.TopContacts) != 0 {
		t.Errorf("sub2 top = %+v, want empty", sub2.TopContacts)
	}

	// Graph.
	byKind := map[string][]MgmtNode{}
	for _, n := range out.Graph.Nodes {
		byKind[n.Kind] = append(byKind[n.Kind], n)
	}
	if len(byKind["self"]) != 1 || byKind["self"][0].Address != "me@t" || byKind["self"][0].Volume != 3 {
		t.Errorf("self node = %+v, want me@t vol 3 (1 in + 2 out)", byKind["self"])
	}
	if len(byKind["sub"]) != 2 {
		t.Fatalf("sub nodes = %+v", byKind["sub"])
	}
	if byKind["sub"][0].Address != "sub1@t" || byKind["sub"][0].Volume != 5 {
		t.Errorf("sub1 node = %+v, want vol 5 (2 in + 3 out)", byKind["sub"][0])
	}
	if byKind["sub"][1].Address != "sub2@t" || byKind["sub"][1].Volume != 0 {
		t.Errorf("sub2 node = %+v, want vol 0", byKind["sub"][1])
	}
	// externals: ext1 (from sub1's top, vol 3) + ext2 (from me's top, vol 1).
	ext := map[string]int{}
	for _, n := range byKind["external"] {
		ext[n.Address] = n.Volume
	}
	if len(ext) != 2 || ext["ext1@t"] != 3 || ext["ext2@t"] != 1 {
		t.Errorf("external nodes = %v, want ext1:3 ext2:1", ext)
	}

	edge := func(a, b string) *MgmtEdge {
		for i := range out.Graph.Edges {
			e := &out.Graph.Edges[i]
			if (e.A == a && e.B == b) || (e.A == b && e.B == a) {
				return e
			}
		}
		return nil
	}
	if e := edge("me@t", "sub1@t"); e == nil || e.AToB != 1 || e.BToA != 1 || e.LastAt != w {
		t.Errorf("me-sub1 edge = %+v", e)
	}
	if e := edge("sub1@t", "ext1@t"); e == nil ||
		!(e.A == "ext1@t" && e.AToB == 1 && e.BToA == 2 || e.A == "sub1@t" && e.AToB == 2 && e.BToA == 1) {
		t.Errorf("sub1-ext1 edge = %+v", e)
	}
	if e := edge("me@t", "ext2@t"); e == nil ||
		!(e.A == "ext2@t" && e.AToB == 0 && e.BToA == 1 || e.A == "me@t" && e.AToB == 1 && e.BToA == 0) {
		t.Errorf("me-ext2 edge = %+v", e)
	}
	// me→sub2 happened only OUTSIDE the window: no edge, though sub2's
	// all-time last_in is set.
	if e := edge("me@t", "sub2@t"); e != nil {
		t.Errorf("me-sub2 edge should not exist (outside 7d window): %+v", e)
	}
}

// TestMgmtSubsOverviewEmpty: no declared subordinates -> 200-shape empty
// (subs [], graph nodes/edges []) even when messages exist; JSON must not
// emit null slices.
func TestMgmtSubsOverviewEmpty(t *testing.T) {
	s := newMgmtStore(t)
	putMsg(t, s, "me@t", []string{"ext1@t"}, nil, "hello", time.Now().Unix())
	out, err := s.MgmtSubsOverview("me@t")
	if err != nil {
		t.Fatalf("overview: %v", err)
	}
	if len(out.Subs) != 0 || len(out.Graph.Nodes) != 0 || len(out.Graph.Edges) != 0 {
		t.Fatalf("want empty overview, got %+v", out)
	}
	b, _ := json.Marshal(out)
	if strings.Contains(string(b), "null") {
		t.Errorf("json contains null: %s", b)
	}
}

// TestMgmtAttributionTo0 pins the contract change (01M0T4RY): contact and
// graph attribution uses ONLY (from, to[0]) — cc and 2nd+ recipients feed
// neither top_contacts nor edges, while mailbox counts still see them.
func TestMgmtAttributionTo0(t *testing.T) {
	s := newMgmtStore(t)
	if err := s.DeclareSubordinate("me@t", "sub1@t"); err != nil {
		t.Fatalf("declare: %v", err)
	}
	if err := s.DeclareSubordinate("me@t", "sub2@t"); err != nil {
		t.Fatalf("declare: %v", err)
	}
	base := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC).Unix()
	w := base - 3600

	// ext1 → [sub1, sub2]: attributed to sub1 only.
	putMsg(t, s, "ext1@t", []string{"sub1@t", "sub2@t"}, nil, str(60), w)
	// me → sub1, cc sub2: attributed to sub1 only (cc never counts).
	putMsg(t, s, "me@t", []string{"sub1@t"}, []string{"sub2@t"}, str(15), w)

	s.now = func() time.Time { return time.Unix(base, 0).UTC() }
	out, err := s.MgmtSubsOverview("me@t")
	if err != nil {
		t.Fatalf("overview: %v", err)
	}
	var sub2 MgmtSubSummary
	for _, x := range out.Subs {
		if x.Address == "sub2@t" {
			sub2 = x
		}
	}
	// sub2 RECEIVED both messages (mailbox semantics unchanged)…
	if sub2.CountIn7d != 2 || sub2.AvgLenIn != (60+15)/2 || sub2.LastInAt != w {
		t.Errorf("sub2 mailbox = %+v, want in=2 avg=37 last=w", sub2)
	}
	// …but no contact attribution: no top_contacts, no edges to sub2.
	if len(sub2.TopContacts) != 0 {
		t.Errorf("sub2 top_contacts = %+v, want empty (To[1]/cc never attributed)", sub2.TopContacts)
	}
	for _, e := range out.Graph.Edges {
		if e.A == "sub2@t" || e.B == "sub2@t" {
			t.Errorf("edge touching sub2 should not exist: %+v", e)
		}
	}
	// sub1 owns both attributions: ext1 (external→to0) and me (core→to0).
	var sub1 MgmtSubSummary
	for _, x := range out.Subs {
		if x.Address == "sub1@t" {
			sub1 = x
		}
	}
	got := map[string]int{}
	for _, c := range sub1.TopContacts {
		got[c.Address] = c.Count
	}
	// ext1→[sub1,sub2] attributes to sub1; me→sub1 attributes to ME's
	// contacts (sender side), not sub1's — sub1's own contacts only gain
	// "me" from messages sub1 SENDS to me (none here).
	if len(got) != 1 || got["ext1@t"] != 1 {
		t.Errorf("sub1 contacts = %v, want ext1:1 only", got)
	}
	// The me→sub1 message does surface as a directed edge (sender side).
	var meSub1 *MgmtEdge
	for i := range out.Graph.Edges {
		e := &out.Graph.Edges[i]
		if (e.A == "me@t" && e.B == "sub1@t") || (e.A == "sub1@t" && e.B == "me@t") {
			meSub1 = e
		}
	}
	if meSub1 == nil {
		t.Fatal("me-sub1 edge missing")
	}
	if meSub1.A == "me@t" && meSub1.AToB != 1 || meSub1.B == "me@t" && meSub1.BToA != 1 {
		t.Errorf("me-sub1 edge direction wrong: %+v", meSub1)
	}
	// me↔ext2 has no message here: no such edge at all.
	for _, e := range out.Graph.Edges {
		if (e.A == "me@t" && e.B == "ext2@t") || (e.A == "ext2@t" && e.B == "me@t") {
			t.Errorf("me-ext2 edge should not exist: %+v", e)
		}
	}
}

// TestMgmtOverviewNoDanglingEdgeAfterRemoval pins the v0.6.5 acceptance
// point "解除后两端视图立即干净": after a subordinate removal the graph must
// be clean immediately. The removal's system notification mail is itself
// 7d-window traffic to the removed address, so edges must additionally be
// restricted to pairs between rendered nodes — otherwise a dangling edge
// (endpoint not in nodes[]) lingers in the payload for the whole window.
func TestMgmtOverviewNoDanglingEdgeAfterRemoval(t *testing.T) {
	s := newMgmtStore(t)
	if err := s.DeclareSubordinate("me@t", "sub1@t"); err != nil {
		t.Fatalf("declare: %v", err)
	}
	// Removal deposits the notification (me -> sub1) in the same tx.
	if role, err := s.RemoveSubordinate("me@t", "sub1@t"); err != nil || role != "superior" {
		t.Fatalf("remove: role=%q err=%v", role, err)
	}
	out, err := s.MgmtSubsOverview("me@t")
	if err != nil {
		t.Fatalf("overview: %v", err)
	}
	nodeSet := map[string]bool{}
	for _, n := range out.Graph.Nodes {
		nodeSet[n.Address] = true
	}
	for _, e := range out.Graph.Edges {
		if e.A == "sub1@t" || e.B == "sub1@t" {
			t.Fatalf("edge touching removed sub still present: %+v", e)
		}
		if !nodeSet[e.A] || !nodeSet[e.B] {
			t.Fatalf("dangling edge (endpoint not a node): %+v", e)
		}
	}
}

// 0021: the subordinate row carries the account's avatar_hash so the
// superior-side list can hydrate real avatars (empty = generator). Saving an
// avatar must surface it; deleting must drop it back to empty.
func TestMgmtSubsAvatarHash(t *testing.T) {
	s := newMgmtStore(t)
	if err := s.DeclareSubordinate("me@t", "sub1@t"); err != nil {
		t.Fatalf("declare sub1: %v", err)
	}

	ov, err := s.MgmtSubsOverview("me@t")
	if err != nil {
		t.Fatalf("overview: %v", err)
	}
	if len(ov.Subs) != 1 || ov.Subs[0].Address != "sub1@t" {
		t.Fatalf("want single sub1 row, got %+v", ov.Subs)
	}
	if ov.Subs[0].AvatarHash != "" {
		t.Fatalf("pre-save hash = %q, want empty", ov.Subs[0].AvatarHash)
	}

	hash, err := s.SaveAvatar("sub1@t", []byte("fake-png-bytes"))
	if err != nil {
		t.Fatalf("save avatar: %v", err)
	}
	ov, err = s.MgmtSubsOverview("me@t")
	if err != nil {
		t.Fatalf("overview: %v", err)
	}
	if ov.Subs[0].AvatarHash != hash {
		t.Fatalf("post-save hash = %q, want %q", ov.Subs[0].AvatarHash, hash)
	}

	if err := s.DeleteAvatar("sub1@t"); err != nil {
		t.Fatalf("delete avatar: %v", err)
	}
	ov, err = s.MgmtSubsOverview("me@t")
	if err != nil {
		t.Fatalf("overview: %v", err)
	}
}

// TestMgmtLatestRelatedToMe (0023, boss field report): the row-3
// "latest" only counts exchanges WITH the login account - a sub
// mailing third parties must not surface (nor reorder the list).
func TestMgmtLatestRelatedToMe(t *testing.T) {
	s := newMgmtStore(t)
	if err := s.DeclareSubordinate("me@t", "sub1@t"); err != nil {
		t.Fatalf("declare sub1: %v", err)
	}
	base := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC).Unix()
	put := func(from, to, subj string, at int64) {
		m := Message{ID: newULID(), From: from, To: []string{to}, Subject: subj, Body: "b", ReceivedAt: at}
		val, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.db.Update(func(tx *bolt.Tx) error {
			return tx.Bucket(bMessages).Put([]byte(m.ID), val)
		}); err != nil {
			t.Fatalf("put msg: %v", err)
		}
	}
	put("sub1@t", "ext1@t", "unrelated-out", base-3600) // newer, unrelated
	put("ext2@t", "sub1@t", "unrelated-in", base-1800)  // newer, unrelated
	put("me@t", "sub1@t", "related", base-7200)         // older, related

	out, err := s.MgmtSubsOverview("me@t")
	if err != nil {
		t.Fatalf("overview: %v", err)
	}
	if len(out.Subs) != 1 {
		t.Fatalf("len(subs) = %d, want 1", len(out.Subs))
	}
	if out.Subs[0].LatestAt != base-7200 {
		t.Fatalf("latest_at = %d, want %d (related only)", out.Subs[0].LatestAt, base-7200)
	}
	if out.Subs[0].LatestSubject != "related" {
		t.Fatalf("latest_subject = %q, want %q", out.Subs[0].LatestSubject, "related")
	}
}

// TestMgmtContactLatests (bug fix 09-29 via boss): the accounts-page
// latest line for NON-subordinate rows must be driven by correspondence
// alone - visibility plays no part, and a sub-less account still gets
// contact latest (the subs-overview early return never ran for it).
func TestMgmtContactLatests(t *testing.T) {
	s := newMgmtStore(t)
	if err := s.DeclareSubordinate("me@t", "sub1@t"); err != nil {
		t.Fatalf("declare sub1: %v", err)
	}
	base := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC).Unix()
	put := func(from, to, subj string, at int64, cc ...string) {
		m := Message{ID: newULID(), From: from, To: []string{to}, CC: cc, Subject: subj, Body: "b", ReceivedAt: at}
		val, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.db.Update(func(tx *bolt.Tx) error {
			return tx.Bucket(bMessages).Put([]byte(m.ID), val)
		}); err != nil {
			t.Fatalf("put msg: %v", err)
		}
	}
	put("me@t", "ext1@t", "my-out-to-ext1", base-3600)
	put("ext1@t", "me@t", "ext1-replied-newer", base-1800)
	put("ext2@t", "me@t", "in-from-ext2", base-7200)
	put("me@t", "other2@t", "i-mailed-them", base-50)
	put("ext3@t", "stranger@t", "no-me-involved", base-100)
	put("sub1@t", "me@t", "from-my-sub", base-100)

	out, err := s.MgmtContactLatests("me@t")
	if err != nil {
		t.Fatalf("contacts latest: %v", err)
	}
	got := map[string]MgmtContactLatest{}
	for _, c := range out {
		got[c.Address] = c
	}
	if len(out) != 3 {
		t.Fatalf("len(contacts) = %d (%v), want 3", len(out), out)
	}
	if c := got["ext1@t"]; c.LatestAt != base-1800 || c.LatestSubject != "ext1-replied-newer" || c.LatestDir != "in" {
		t.Fatalf("ext1 = %+v, want newer reply (in)", c)
	}
	if c := got["other2@t"]; c.LatestDir != "out" {
		t.Fatalf("other2 dir = %q, want out (my outbound is the latest)", c.LatestDir)
	}
	if c := got["ext2@t"]; c.LatestAt != base-7200 || c.LatestSubject != "in-from-ext2" {
		t.Fatalf("ext2 = %+v", c)
	}
	if c := got["other2@t"]; c.LatestAt != base-50 || c.LatestSubject != "i-mailed-them" {
		t.Fatalf("other2 = %+v", c)
	}
	for _, absent := range []string{"ext3@t", "sub1@t", "me@t", "stranger@t"} {
		if _, ok := got[absent]; ok {
			t.Fatalf("%s must not appear (unrelated or subordinate)", absent)
		}
	}
	// Deterministic order: addresses ascending.
	for i := 1; i < len(out); i++ {
		if out[i-1].Address >= out[i].Address {
			t.Fatalf("contacts not sorted: %v", out)
		}
	}
}

// TestMgmtLatestBody (0.3.4 item 1 companion): latest_body rides the same
// 0023 me-pair gate as latest_subject and never diverges from it - the
// client swaps a "no information" subject for the body on display.
func TestMgmtLatestBody(t *testing.T) {
	s := newMgmtStore(t)
	if err := s.DeclareSubordinate("me@t", "sub1@t"); err != nil {
		t.Fatalf("declare: %v", err)
	}
	base := time.Date(2026, 9, 29, 0, 0, 0, 0, time.UTC).Unix()
	put := func(from, to, subj, body string, at int64) {
		m := Message{ID: newULID(), From: from, To: []string{to}, Subject: subj, Body: body, ReceivedAt: at}
		val, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.db.Update(func(tx *bolt.Tx) error {
			return tx.Bucket(bMessages).Put([]byte(m.ID), val)
		}); err != nil {
			t.Fatalf("put msg: %v", err)
		}
	}
	put("sub1@t", "me@t", "短信", "正文内容在这里：无主题也要有信息量", base-3600)
	put("sub1@t", "stranger@t", "unrelated out", "x", base-1800)
	put("stranger@t", "sub1@t", "unrelated in", "y", base-60)

	out, err := s.MgmtSubsOverview("me@t")
	if err != nil {
		t.Fatalf("overview: %v", err)
	}
	if len(out.Subs) != 1 {
		t.Fatalf("len(subs) = %d, want 1", len(out.Subs))
	}
	row := out.Subs[0]
	if row.LatestSubject != "短信" || row.LatestBody != "正文内容在这里：无主题也要有信息量" {
		t.Fatalf("latest pair = (%q, %q), want subject+body captured together", row.LatestSubject, row.LatestBody)
	}
	// Unrelated traffic must not have moved the pair (0023 gate).
	if row.LatestAt != base-3600 {
		t.Fatalf("latest_at = %d, want the related one only", row.LatestAt)
	}
}

// TestUnreadBySender (0.3.4 item 1): per-sender unread counts from the
// login account's own inbox - server truth for the per-row avatar dot.
func TestUnreadBySender(t *testing.T) {
	s := newMgmtStore(t)
	if err := s.DeclareSubordinate("me@t", "sub1@t"); err != nil {
		t.Fatalf("declare: %v", err)
	}
	for _, m := range []struct{ from, subj string }{
		{"ext1@t", "u1"}, {"ext1@t", "u2"}, {"sub1@t", "u3"}, {"ext2@t", "r1"},
	} {
		if _, err := s.Send(m.from, m.from, []string{"me@t"}, nil, m.subj, "b", ""); err != nil {
			t.Fatalf("send %s: %v", m.subj, err)
		}
	}
	// Read ext2's letter: any read path must drop the sender off the list.
	me, err := s.GetAccount("me@t")
	if err != nil {
		t.Fatalf("me: %v", err)
	}
	inbox, err := s.ReadInbox("me@t", 20)
	if err != nil {
		t.Fatalf("inbox: %v", err)
	}
	var readID string
	for _, m := range inbox {
		if m.From == "ext2@t" {
			readID = m.ID
		}
	}
	if readID == "" {
		t.Fatal("ext2 letter not in inbox")
	}
	if err := s.MarkRead(me.UUID, readID); err != nil {
		t.Fatalf("mark read: %v", err)
	}

	out, err := s.UnreadBySender("me@t")
	if err != nil {
		t.Fatalf("unread by sender: %v", err)
	}
	if out["ext1@t"] != 2 || out["sub1@t"] != 1 {
		t.Fatalf("counts = %v, want ext1:2 sub1:1", out)
	}
	if _, ok := out["ext2@t"]; ok {
		t.Fatalf("read sender must be absent: %v", out)
	}
	if len(out) != 2 {
		t.Fatalf("len = %d (%v), want 2", len(out), out)
	}
}
