package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	bolt "go.etcd.io/bbolt"
)

// Push subscriptions (v0.6.30 app notifications, docs/push/DESIGN.md).
// Each record binds a Web Push endpoint to the account that created it —
// ownership is enforced at creation time (the request must carry that
// account's credential), so a subscription can never outlive or escape its
// owner. The endpoint is stored hashed as the key tail: the bbolt file alone
// must not yield usable push targets (same reasoning as session-token
// hashing, v0.6.27).
//
// Multiple devices per account coexist as separate entries; logout does NOT
// remove them (multi-device friendly), but DELETE /api/push/subscribe and
// account deletion do.

var ErrPushSubInvalid = errors.New("push subscription invalid")

// PushSubscription is one device's Web Push registration.
type PushSubscription struct {
	Address   string `json:"address"`    // owner account
	Endpoint  string `json:"endpoint"`   // push service URL (HTTPS)
	P256dh    string `json:"p256dh"`     // client public key
	Auth      string `json:"auth"`       // auth secret
	CreatedAt int64  `json:"created_at"`
}

func subHash(endpoint string) []byte {
	h := sha256.Sum256([]byte(endpoint))
	return []byte(hex.EncodeToString(h[:]))
}

func pushSubKey(address, endpoint string) []byte {
	key := append([]byte(address), 0)
	return append(key, subHash(endpoint)...)
}

// UpsertPushSub stores (or idempotently re-stores) a subscription. The same
// endpoint re-registering for the same account overwrites in place — devices
// refresh keys freely; an endpoint owned by another account is rejected so
// one account cannot hijack another's registration.
func (s *Store) UpsertPushSub(rec *PushSubscription) error {
	if rec.Address == "" || rec.Endpoint == "" {
		return ErrPushSubInvalid
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bPushSubs)
		key := pushSubKey(rec.Address, rec.Endpoint)
		if old := b.Get(key); old != nil {
			var prev PushSubscription
			if json.Unmarshal(old, &prev) == nil && prev.Address != rec.Address {
				return ErrPushSubInvalid // endpoint claimed by someone else
			}
		}
		data, err := json.Marshal(rec)
		if err != nil {
			return err
		}
		return b.Put(key, data)
	})
}

// RemovePushSub deletes one subscription; safe when absent.
func (s *Store) RemovePushSub(address, endpoint string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bPushSubs).Delete(pushSubKey(address, endpoint))
	})
}

// PushSubsByAddress lists every live subscription of the account (M2's send
// fan-out will iterate this set on successful local delivery).
func (s *Store) PushSubsByAddress(address string) ([]*PushSubscription, error) {
	var out []*PushSubscription
	err := s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(bPushSubs).Cursor()
		prefix := append([]byte(address), 0)
		for k, v := c.Seek(prefix); k != nil && string(k[:len(prefix)]) == string(prefix); k, v = c.Next() {
			var rec PushSubscription
			if json.Unmarshal(v, &rec) == nil {
				out = append(out, &rec)
			}
		}
		return nil
	})
	return out, err
}

// DeleteAllPushSubs wipes every subscription of the account (account removal
// cascade must not leave orphaned endpoints behind).
func (s *Store) DeleteAllPushSubs(address string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		c := tx.Bucket(bPushSubs).Cursor()
		prefix := append([]byte(address), 0)
		var doomed [][]byte
		for k, _ := c.Seek(prefix); k != nil && string(k[:len(prefix)]) == string(prefix); k, _ = c.Next() {
			doomed = append(doomed, append([]byte(nil), k...))
		}
		for _, k := range doomed {
			if err := tx.Bucket(bPushSubs).Delete(k); err != nil {
				return err
			}
		}
		return nil
	})
}
