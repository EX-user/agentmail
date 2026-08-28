package store

import (
	"testing"

	bolt "go.etcd.io/bbolt"
)

// Regression for the superior's case-variant report (alice 01M13YGD): sends
// to an uppercase address variant must resolve the lowercase-stored account
// (275d0ba made GetAccount case-insensitive; the in-transaction send path
// must match).
func TestSendToUppercaseRecipient(t *testing.T) {
	s := newTokensStore(t) // registers alice@t

	res, err := s.Send("alice@t", "Alice", []string{"ALICE@T"}, nil, "case", "body", "")
	if err != nil {
		t.Fatalf("send to uppercase variant failed: %v", err)
	}
	_ = res
	msgs, err := s.ReadInboxPaged("alice@t", 10, 0)
	if err != nil || len(msgs) != 1 {
		t.Fatalf("uppercase recipient delivery missing: %d msgs (%v)", len(msgs), err)
	}
}

// TestSendFromHeaderNormalized: the stored From must be the lowercase key
// even when the authenticated address arrives in uppercase (ruling 5).
func TestSendFromHeaderNormalized(t *testing.T) {
	s := newTokensStore(t)
	if _, err := s.Send("ALICE@t", "A", []string{"alice@t"}, nil, "f", "b", ""); err != nil {
		t.Fatalf("send: %v", err)
	}
	msgs, _ := s.ReadInboxPaged("alice@t", 10, 0)
	if len(msgs) != 1 || msgs[0].From != "alice@t" {
		t.Fatalf("From not normalized: %+v", msgs)
	}
}

// TestLegacyMixedCaseKeyResolvable: rows created before normalization (keys
// stored mixed-case) must still resolve for sends, until the cleanup runs.
func TestLegacyMixedCaseKeyResolvable(t *testing.T) {
	s := newTokensStore(t)
	// Simulate a legacy row by writing a mixed-case key directly through the
	// same bucket (no public API creates these anymore).
	si, _ := s.CreateAccountWithPassword("legacy", "t", false, "pw-one-2-3")
	_ = si
	if err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("accounts"))
		v := b.Get([]byte("legacy@t"))
		b.Delete([]byte("legacy@t"))
		return b.Put([]byte("LEGACY@t"), v)
	}); err != nil {
		t.Fatalf("seed legacy row: %v", err)
	}
	if _, err := s.Send("alice@t", "A", []string{"LEGACY@T"}, nil, "f", "b", ""); err != nil {
		t.Fatalf("legacy mixed-case recipient must resolve: %v", err)
	}
}
