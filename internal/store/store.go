// Package store is agentmail's embedded message store. It is a single bbolt
// file holding accounts, messages, and per-account inbox/sent indexes. The
// server process owns the only open handle; the gateway never touches storage
// directly (it talks to the server over HTTP).
//
// Storage model (see docs/architecture.md):
//
//	accounts  : address                 -> Account (JSON)
//	messages  : ulid                    -> Message (JSON)   [the data body]
//	inbox     : uuid(16B) + ulid(26B)   -> ""               [index: who sees it]
//	sent      : uuid(16B) + ulid(26B)   -> ""               [index: who sent it]
//
// Messages are stored once; inbox/sent hold references. Deleting an inbox
// entry means "this account no longer sees this message"; the message body is
// left for a future GC pass. This is the mailbox model from real mail servers
// (each recipient gets a logical copy) implemented space-efficiently.
package store

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	bolt "go.etcd.io/bbolt"
)

// Bucket names.
var (
	bAccounts = []byte("accounts")
	bMessages = []byte("messages")
	bInbox    = []byte("inbox")
	bSent     = []byte("sent")
	bUnread   = []byte("unread") // key: uuid(32 hex) + ulid(26) -> exists = unread for that account
	bMeta     = []byte("meta")   // system metadata (initialized flag, domain, ...)
)

// Meta keys within the meta bucket.
var (
	mInitialized = []byte("initialized")
	mDomain      = []byte("domain")
)

// Store wraps a bbolt database with agentmail's operations.
type Store struct {
	db  *bolt.DB
	now func() time.Time
}

// Open opens (or creates) the bbolt database at path and initializes buckets.
func Open(path string) (*Store, error) {
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 5 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("open bbolt %q: %w", path, err)
	}
	s := &Store{db: db, now: time.Now}
	if err := db.Update(func(tx *bolt.Tx) error {
		for _, b := range [][]byte{bAccounts, bMessages, bInbox, bSent, bUnread, bMeta} {
			if _, err := tx.CreateBucketIfNotExists(b); err != nil {
				return fmt.Errorf("create bucket %q: %w", b, err)
			}
		}
		return nil
	}); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close releases the database handle.
func (s *Store) Close() error { return s.db.Close() }

// DB returns the underlying bbolt handle so other stores (e.g. audit) can
// share the same database file. The handle stays owned by this Store; callers
// must not close it.
func (s *Store) DB() *bolt.DB { return s.db }

// --- key helpers ---

// indexKey builds the inbox/sent key: 16-byte hex UUID + 26-char ULID.
// The UUID prefix groups a recipient's messages together; the ULID tail makes
// them sort chronologically within that group.
func indexKey(uuidHex, ulid string) []byte {
	out := make([]byte, len(uuidHex)+len(ulid))
	copy(out, uuidHex)
	copy(out[len(uuidHex):], ulid)
	return out
}

// hexID returns 16 random bytes as a 32-char hex string. Used as an account's
// internal UUID.
func hexID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("store: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}

// CountAccounts returns the total number of accounts. Used by the admin stats.
func (s *Store) CountAccounts() (int, error) {
	n := 0
	err := s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(bAccounts).Cursor()
		for k, _ := c.First(); k != nil; k, _ = c.Next() {
			n++
		}
		return nil
	})
	return n, err
}

// CountMessages returns the total number of stored message bodies. Note this
// counts unique messages, not inbox/sent references.
func (s *Store) CountMessages() (int, error) {
	n := 0
	err := s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(bMessages).Cursor()
		for k, _ := c.First(); k != nil; k, _ = c.Next() {
			n++
		}
		return nil
	})
	return n, err
}

// --- system metadata (meta bucket) ---

// IsInitialized reports whether the system has been bootstrapped (admin
// account created via setup wizard or config migration).
func (s *Store) IsInitialized() bool {
	var ok bool
	_ = s.db.View(func(tx *bolt.Tx) error {
		mb := tx.Bucket(bMeta)
		if mb == nil {
			return nil
		}
		ok = string(mb.Get(mInitialized)) == "1"
		return nil
	})
	return ok
}

// SetInitialized marks the system as bootstrapped.
func (s *Store) SetInitialized() error {
	return s.db.Update(func(tx *bolt.Tx) error {
		mb := tx.Bucket(bMeta)
		if mb == nil {
			return nil
		}
		return mb.Put(mInitialized, []byte("1"))
	})
}

// GetDomain returns the system domain set during bootstrap, or "" if unset.
func (s *Store) GetDomain() string {
	var d string
	_ = s.db.View(func(tx *bolt.Tx) error {
		mb := tx.Bucket(bMeta)
		if mb == nil {
			return nil
		}
		if v := mb.Get(mDomain); v != nil {
			d = string(v)
		}
		return nil
	})
	return d
}

// SetDomain persists the system domain (used during bootstrap).
func (s *Store) SetDomain(domain string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		mb := tx.Bucket(bMeta)
		if mb == nil {
			return nil
		}
		return mb.Put(mDomain, []byte(domain))
	})
}
