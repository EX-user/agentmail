package store

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

// newGrowthTestStore opens a throwaway store and seeds messages at the given
// unix timestamps (bypassing Send, which always stamps "now").
func newGrowthTestStore(t *testing.T, stamps []int64) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.db")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { s.db.Close() })
	if err := s.db.Update(func(tx *bolt.Tx) error {
		mb := tx.Bucket(bMessages)
		for i, ts := range stamps {
			m := Message{ID: newTestULID(i), From: "a@t", To: []string{"b@t"}, ReceivedAt: ts}
			val, err := json.Marshal(m)
			if err != nil {
				return err
			}
			if err := mb.Put([]byte(m.ID), val); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	return s
}

func newTestULID(i int) string {
	// Any unique, ULID-shaped key works; the growth scan does not rely on
	// ordering, only on ReceivedAt.
	return time.Now().UTC().Format("20060102150405") + "-msg-" + string(rune('a'+i)) + "0000000000000000"
}

func TestMessageGrowthBuckets(t *testing.T) {
	now := time.Date(2026, 8, 14, 15, 0, 0, 0, time.UTC)
	dayStart := time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC).Unix()
	weekStart := now.Unix() - 7*24*3600
	monthStart := now.Unix() - 30*24*3600

	stamps := []int64{
		now.Unix() - 60,      // today (also week + month)
		dayStart,             // exactly midnight: today
		now.Unix() - 3600,    // earlier today (before "now-60" chronologically, still today)
		weekStart,            // exactly 7 days ago: week bucket edge
		weekStart - 1,        // just past a week: month only
		monthStart,           // exactly 30 days ago: month bucket edge
		monthStart - 86400,   // older than a month: total only
	}
	s := newGrowthTestStore(t, stamps)

	g, err := s.MessageGrowth(now)
	if err != nil {
		t.Fatalf("MessageGrowth: %v", err)
	}
	// today: msgs at now-60, midnight, now-3600 => 3
	// week:  those 3 + weekStart exactly (>= weekStart) => 4
	// month: those 4 + (weekStart-1) + monthStart exactly => 6
	// total: 7
	if g.Today != 3 {
		t.Errorf("Today = %d, want 3", g.Today)
	}
	if g.Week != 4 {
		t.Errorf("Week = %d, want 4", g.Week)
	}
	if g.Month != 6 {
		t.Errorf("Month = %d, want 6", g.Month)
	}
	if g.Total != 7 {
		t.Errorf("Total = %d, want 7", g.Total)
	}
}

func TestMessageGrowthEmpty(t *testing.T) {
	s := newGrowthTestStore(t, nil)
	g, err := s.MessageGrowth(time.Now())
	if err != nil {
		t.Fatalf("MessageGrowth: %v", err)
	}
	if g != (Growth{}) {
		t.Errorf("empty store growth = %+v, want zero", g)
	}
}

// TestMessageGrowthSkipsCorrupt verifies one bad record doesn't fail the scan.
func TestMessageGrowthSkipsCorrupt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.db.Close() })
	now := time.Now()
	if err := s.db.Update(func(tx *bolt.Tx) error {
		mb := tx.Bucket(bMessages)
		good, _ := json.Marshal(Message{ID: "G1", ReceivedAt: now.Unix()})
		if err := mb.Put([]byte("G1"), good); err != nil {
			return err
		}
		return mb.Put([]byte("BAD"), []byte("not json"))
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	g, err := s.MessageGrowth(now)
	if err != nil {
		t.Fatalf("MessageGrowth should not fail on corrupt record: %v", err)
	}
	if g.Total != 1 {
		t.Errorf("Total = %d, want 1 (corrupt skipped)", g.Total)
	}
}
