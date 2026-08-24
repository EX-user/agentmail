package store

import (
	"errors"
	"testing"
	"time"
)

// TestListAccountFiles pins the management-card contract: own files only,
// expiry (CreatedAt) ascending, ExpiresAt derived as CreatedAt + FileTTL.
func TestListAccountFiles(t *testing.T) {
	s := newFilesStore(t)
	base := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)

	s.now = func() time.Time { return base.Add(-10 * 24 * time.Hour) }
	old, err := s.SaveFile("a@t", "old.txt", nil, []byte("old-content"))
	if err != nil {
		t.Fatalf("save old: %v", err)
	}
	s.now = func() time.Time { return base }
	fresh, err := s.SaveFile("a@t", "fresh.txt", nil, []byte("fresh-content"))
	if err != nil {
		t.Fatalf("save fresh: %v", err)
	}
	if _, err := s.SaveFile("b@t", "other.txt", nil, []byte("other")); err != nil {
		t.Fatalf("save b: %v", err)
	}

	files, err := s.ListAccountFiles("a@t")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("len(files) = %d, want 2 (b@t's file must be excluded)", len(files))
	}
	if files[0].ID != old.ID || files[1].ID != fresh.ID {
		t.Errorf("order = [%s, %s], want oldest first", files[0].ID, files[1].ID)
	}
	ttlSecs := int64(FileTTL.Seconds())
	for _, f := range files {
		if f.ExpiresAt != f.CreatedAt+ttlSecs {
			t.Errorf("file %s: expires_at %d != created_at + TTL (%d)", f.ID, f.ExpiresAt, f.CreatedAt+ttlSecs)
		}
		if f.Filename == "" || f.Size <= 0 {
			t.Errorf("file %s: bad summary fields %+v", f.ID, f)
		}
	}
}

// TestDeleteFile pins the delete contract: own file deletes (meta + data +
// quota reclaims), a foreign id looks exactly like a missing id, and a
// missing id 404s.
func TestDeleteFile(t *testing.T) {
	s := newFilesStore(t)
	rec, err := s.SaveFile("a@t", "del.txt", []string{"b@t"}, []byte("delete-me-please"))
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	usedBefore := s.AccountFilesUsed("a@t")

	// Foreign owner: indistinguishable from missing.
	if err := s.DeleteFile(rec.ID, "b@t"); !errors.Is(err, ErrFileNotFound) {
		t.Fatalf("foreign delete = %v, want ErrFileNotFound", err)
	}
	if _, err := s.GetFileMeta(rec.ID); err != nil {
		t.Fatalf("file vanished after REJECTED delete: %v", err)
	}
	// Missing id.
	if err := s.DeleteFile("no-such-id", "a@t"); !errors.Is(err, ErrFileNotFound) {
		t.Fatalf("missing delete = %v, want ErrFileNotFound", err)
	}
	// Owner delete: meta + content gone, quota reclaimed.
	if err := s.DeleteFile(rec.ID, "a@t"); err != nil {
		t.Fatalf("own delete: %v", err)
	}
	if _, err := s.GetFileMeta(rec.ID); !errors.Is(err, ErrFileNotFound) {
		t.Errorf("meta still present after delete: %v", err)
	}
	if _, err := s.GetFileContent(rec.ID); !errors.Is(err, ErrFileNotFound) {
		t.Errorf("content still present after delete: %v", err)
	}
	if used := s.AccountFilesUsed("a@t"); used != usedBefore-rec.Size {
		t.Errorf("used after delete = %d, want %d (quota not reclaimed)", used, usedBefore-rec.Size)
	}
}
