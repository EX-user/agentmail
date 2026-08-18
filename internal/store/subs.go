package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	bolt "go.etcd.io/bbolt"
)

// Subordinate accounts (v1 design, alice-approved):
//
// A may unconditionally declare itself a subordinate of B ("self-declare" —
// a directional visibility grant, not a credential relationship). The server
// keeps a relationship graph in bSubs; queries never recurse. A may revoke
// at any time; revocation is immediate because read paths look the bucket
// up live (no caching).
//
// Key layout: B (superior address, lowercased) + 0x00 + A (subordinate
// address, lowercased) -> SubRecord JSON. Lowercasing makes the graph
// case-insensitive like the rest of the address handling.

// ErrNoSuchAccount is returned when a declare names a non-existent account.
var ErrNoSuchAccount = errors.New("no such account")

// SubRecord is the value stored per relationship edge.
type SubRecord struct {
	Scope     string `json:"scope"` // visibility scope; v1 always "both" (inbox+sent), field reserved for v2
	CreatedAt int64  `json:"created_at"`
}

// SubEdge is one relationship edge as returned by the listing queries.
type SubEdge struct {
	Address   string `json:"address"`    // the other side (subordinate or superior, per query)
	Scope     string `json:"scope"`
	CreatedAt int64  `json:"created_at"`
}

// subKey builds the bSubs key for "subordinate declares under superior".
func subKey(superior, subordinate string) []byte {
	return []byte(strings.ToLower(superior) + "\x00" + strings.ToLower(subordinate))
}

// splitSubKey recovers (superior, subordinate) from a bSubs key.
func splitSubKey(key []byte) (superior, subordinate string) {
	if i := strings.IndexByte(string(key), 0); i >= 0 {
		return string(key[:i]), string(key[i+1:])
	}
	return string(key), ""
}

// DeclareSubordinate records that subordinate (A) declares itself under
// superior (B). Both accounts must exist and differ. Idempotent: a repeat
// declaration refreshes CreatedAt (scope stays v1's "both").
func (s *Store) DeclareSubordinate(superior, subordinate string) error {
	if strings.EqualFold(superior, subordinate) {
		return fmt.Errorf("cannot declare under yourself")
	}
	now := s.now().Unix()
	err := s.db.Update(func(tx *bolt.Tx) error {
		if _, err := getAccountInTx(tx, superior); err != nil {
			return ErrNoSuchAccount
		}
		if _, err := getAccountInTx(tx, subordinate); err != nil {
			return ErrNoSuchAccount
		}
		rec := SubRecord{Scope: "both", CreatedAt: now}
		val, err := json.Marshal(rec)
		if err != nil {
			return err
		}
		return tx.Bucket(bSubs).Put(subKey(superior, subordinate), val)
	})
	if err != nil {
		return fmt.Errorf("declare subordinate: %w", err)
	}
	return nil
}

// RevokeSubordinate removes the edge (A no longer exposes visibility to B).
// Revoking a non-existent edge is not an error (idempotent).
func (s *Store) RevokeSubordinate(superior, subordinate string) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bSubs).Delete(subKey(superior, subordinate))
	})
	if err != nil {
		return fmt.Errorf("revoke subordinate: %w", err)
	}
	return nil
}

// IsSubordinate reports whether subordinate (A) currently declares under
// superior (B). Single point-lookup: the whole read path costs one Get, so
// revocation takes effect on the very next request.
func (s *Store) IsSubordinate(superior, subordinate string) bool {
	var exists bool
	_ = s.db.View(func(tx *bolt.Tx) error {
		exists = tx.Bucket(bSubs).Get(subKey(superior, subordinate)) != nil
		return nil
	})
	return exists
}

// SubordinatesOf lists every A that currently declares under B.
func (s *Store) SubordinatesOf(superior string) []SubEdge {
	var out []SubEdge
	prefix := []byte(strings.ToLower(superior) + "\x00")
	_ = s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(bSubs).Cursor()
		for k, v := c.Seek(prefix); k != nil && strings.HasPrefix(string(k), string(prefix)); k, v = c.Next() {
			_, sub := splitSubKey(k)
			var rec SubRecord
			_ = json.Unmarshal(v, &rec)
			out = append(out, SubEdge{Address: sub, Scope: rec.Scope, CreatedAt: rec.CreatedAt})
		}
		return nil
	})
	return out
}

// SuperiorsOf lists every B that A currently declares under (A's own view,
// the data source for the revoke UI).
func (s *Store) SuperiorsOf(subordinate string) []SubEdge {
	var out []SubEdge
	suffix := []byte("\x00" + strings.ToLower(subordinate))
	_ = s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(bSubs).Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			if !strings.HasSuffix(string(k), string(suffix)) {
				continue
			}
			sup, _ := splitSubKey(k)
			var rec SubRecord
			_ = json.Unmarshal(v, &rec)
			out = append(out, SubEdge{Address: sup, Scope: rec.Scope, CreatedAt: rec.CreatedAt})
		}
		return nil
	})
	return out
}

// SubReadAt returns the timestamp of the last audited read of this pair, for
// the sampled audit (first read per (B,A) per hour). Keyed in bMeta.
func subAuditKey(superior, subordinate string) []byte {
	return []byte("sub_read@" + strings.ToLower(superior) + "\x00" + strings.ToLower(subordinate))
}

// ShouldAuditSubRead reports whether this read is the pair's first within the
// current hour and, if so, records the timestamp (same transaction-free
// best-effort semantics as the showcase tee).
func (s *Store) ShouldAuditSubRead(superior, subordinate string) bool {
	key := subAuditKey(superior, subordinate)
	hour := s.now().Unix() / 3600
	var record bool
	_ = s.db.Update(func(tx *bolt.Tx) error {
		mb := tx.Bucket(bMeta)
		if raw := mb.Get(key); raw != nil {
			var last int64
			if err := json.Unmarshal(raw, &last); err == nil && last == hour {
				return nil // already audited this hour
			}
		}
		record = true
		val, err := json.Marshal(hour)
		if err != nil {
			return err
		}
		return mb.Put(key, val)
	})
	return record
}

// ReadSubordinateMessages returns A's messages (folder: "inbox", "sent", or
// "both") visible to superior B, newest first, capped at limit. Authorization
// (IsSubordinate) must be checked by the caller; this method does not re-check
// so the handler can shape the 404 masquerade. Attachments ride along as
// metadata only — the handler strips access codes per the Q2 ruling.
func (s *Store) ReadSubordinateMessages(subordinate, folder string, limit int) ([]MessageSummary, error) {
	if folder != "inbox" && folder != "sent" && folder != "both" {
		folder = "both"
	}
	if limit <= 0 {
		limit = 50
	}
	// ULIDs are time-ordered, so newest-first = descending string sort on ID.
	// Merge the two sides deduped (a message can appear in both folders only
	// if A sent to itself — rare, but cheap to guard).
	var out []MessageSummary
	seen := map[string]bool{}
	add := func(msgs []MessageSummary) {
		for _, m := range msgs {
			if !seen[m.ID] {
				seen[m.ID] = true
				out = append(out, m)
			}
		}
	}
	if folder == "inbox" || folder == "both" {
		msgs, err := s.ReadInbox(subordinate, limit)
		if err != nil {
			return nil, err
		}
		add(msgs)
	}
	if folder == "sent" || folder == "both" {
		msgs, err := s.ReadSent(subordinate, limit)
		if err != nil {
			return nil, err
		}
		add(msgs)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
