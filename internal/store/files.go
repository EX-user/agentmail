package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

// Attachment system (v0.5): uploaded files live in two buckets — bFiles
// holds lightweight metadata (scans stay cheap), bFileData holds the raw
// content under the same id. Download authorization: the requester must be
// the owner or on the file's allowed list AND present the file's access
// code. TTL evicts both halves.
var (
	bFiles    = []byte("files")
	bFileData = []byte("files_data")
)

// Limits (Phase 1 constants; the total cap is admin-tunable via settings).
const (
	FileMaxBytes     = 1 << 20 // 1MB per file
	FileQuotaPerAcct = 20 << 20 // 20MB per account
	FileTTL          = 30 * 24 * time.Hour
)

// FileRecord is the metadata half of an uploaded file.
type FileRecord struct {
	ID         string   `json:"id"`          // ULID
	Owner      string   `json:"owner"`       // uploader address
	Filename   string   `json:"filename"`    // original name (sanitized on use)
	Size       int64    `json:"size"`
	AccessCode string   `json:"access_code"` // random hex, required at download
	Allowed    []string `json:"allowed"`     // addresses that may download
	CreatedAt  int64    `json:"created_at"`
}

// ErrFileNotFound / ErrQuotaExceeded are surfaced by the store and mapped
// by the handlers (404 / 413).
var (
	ErrFileNotFound  = fmt.Errorf("file not found")
	ErrQuotaExceeded = fmt.Errorf("storage quota exceeded")
)

func fileDataKey(id string) []byte { return []byte(id + ":d") }

// SaveFile stores metadata + content in one transaction (either both land
// or neither). Quota: the owner's live files' total size plus this file
// must stay under FileQuotaPerAcct; the caller enforces the per-file cap
// before reading the whole body.
func (s *Store) SaveFile(owner, filename string, allowed []string, content []byte) (*FileRecord, error) {
	now := s.now()
	id := newULID()
	code, err := randomFileCode()
	if err != nil {
		return nil, err
	}
	rec := FileRecord{
		ID:         id,
		Owner:      owner,
		Filename:   filename,
		Size:       int64(len(content)),
		AccessCode: code,
		Allowed:    allowed,
		CreatedAt:  now.Unix(),
	}
	meta, err := json.Marshal(rec)
	if err != nil {
		return nil, err
	}
	err = s.db.Update(func(tx *bolt.Tx) error {
		fb := tx.Bucket(bFiles)
		// Quota check: sum the owner's live files.
		var used int64
		c := fb.Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			var fr FileRecord
			if json.Unmarshal(v, &fr) == nil && fr.Owner == owner {
				used += fr.Size
			}
		}
		if used+rec.Size > FileQuotaPerAcct {
			return ErrQuotaExceeded
		}
		if err := fb.Put([]byte(id), meta); err != nil {
			return err
		}
		return tx.Bucket(bFileData).Put(fileDataKey(id), content)
	})
	if err != nil {
		return nil, err
	}
	return &rec, nil
}

// GetFileMeta returns the metadata without content.
func (s *Store) GetFileMeta(id string) (*FileRecord, error) {
	var rec FileRecord
	err := s.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bFiles).Get([]byte(id))
		if raw == nil {
			return ErrFileNotFound
		}
		return json.Unmarshal(raw, &rec)
	})
	if err != nil {
		return nil, err
	}
	return &rec, nil
}

// GetFileContent returns the raw bytes.
func (s *Store) GetFileContent(id string) ([]byte, error) {
	var content []byte
	err := s.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bFileData).Get(fileDataKey(id))
		if raw == nil {
			return ErrFileNotFound
		}
		content = append([]byte(nil), raw...)
		return nil
	})
	return content, err
}

// AuthorizeFileDownload: exists + (owner or allowed) + code match.
func (s *Store) AuthorizeFileDownload(requester, id, code string) (*FileRecord, error) {
	rec, err := s.GetFileMeta(id)
	if err != nil {
		return nil, err
	}
	permitted := strings.EqualFold(rec.Owner, requester)
	if !permitted {
		for _, a := range rec.Allowed {
			if strings.EqualFold(a, requester) {
				permitted = true
				break
			}
		}
	}
	if !permitted || !secureEqual(rec.AccessCode, code) {
		// Same error for both failures: no oracle about which check failed.
		return nil, ErrFileNotFound
	}
	return rec, nil
}

// CleanupExpiredFiles removes files older than the TTL. Returns the number
// evicted. Runs at startup and daily.
func (s *Store) CleanupExpiredFiles() (int, error) {
	cutoff := s.now().Add(-FileTTL).Unix()
	var doomed [][]byte
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bFiles).ForEach(func(k, v []byte) error {
			var fr FileRecord
			if json.Unmarshal(v, &fr) != nil || fr.CreatedAt < cutoff {
				// Corrupt records are swept too — they are unreachable anyway.
				doomed = append(doomed, append([]byte(nil), k...))
			}
			return nil
		})
	})
	if err != nil {
		return 0, err
	}
	if len(doomed) == 0 {
		return 0, nil
	}
	err = s.db.Update(func(tx *bolt.Tx) error {
		fb := tx.Bucket(bFiles)
		db_ := tx.Bucket(bFileData)
		for _, k := range doomed {
			var fr FileRecord
			if raw := fb.Get(k); raw != nil && json.Unmarshal(raw, &fr) == nil {
				_ = db_.Delete(fileDataKey(fr.ID))
			}
			if err := fb.Delete(k); err != nil {
				return err
			}
		}
		return nil
	})
	return len(doomed), err
}

// randomFileCode mints a 32-hex-char download code.
func randomFileCode() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// secureEqual compares two short hex strings without early exit.
func secureEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := 0; i < len(a); i++ {
		v |= a[i] ^ b[i]
	}
	return v == 0
}
