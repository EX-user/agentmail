package server

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/agentmail/agentmail/internal/audit"
	"github.com/agentmail/agentmail/internal/store"
)

// Attachment system endpoints (v0.5 Phase 1): upload + download.
//
//   POST /api/files/upload           (multipart: file, allowed="a@x,b@y")
//     -> {"id","access_code","filename","size"}
//   GET  /api/files/{id}/download?code=...   -> raw content
//
// Download authorization: the Basic-auth account must be the owner or on
// the file's allowed list, AND the access code must match. Wrong
// permission and wrong code both answer 404 (no oracle).

const fileUploadMaxMemory = 2 << 20 // buffer the multipart in memory (1MB cap + form overhead)

// handleFileUpload stores one file for the authenticated account.
func (s *Server) handleFileUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	who := accountFrom(r.Context())
	r.Body = http.MaxBytesReader(w, r.Body, store.FileMaxBytes+64<<10)
	if err := r.ParseMultipartForm(fileUploadMaxMemory); err != nil {
		badRequest(w, "invalid multipart form: "+err.Error())
		return
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()

	f, hdr, err := r.FormFile("file")
	if err != nil {
		badRequest(w, "file part is required")
		return
	}
	defer f.Close()

	// Enforce the per-file cap BEFORE reading the whole body into memory.
	if hdr.Size > store.FileMaxBytes {
		http.Error(w, fmt.Sprintf("file too large: %d bytes (limit %d)", hdr.Size, store.FileMaxBytes), http.StatusRequestEntityTooLarge)
		return
	}
	content, err := io.ReadAll(io.LimitReader(f, store.FileMaxBytes+1))
	if err != nil {
		badRequest(w, "read file: "+err.Error())
		return
	}
	if int64(len(content)) > store.FileMaxBytes {
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	}

	name := sanitizeFilename(hdr.Filename)
	var allowed []string
	for _, a := range strings.Split(r.FormValue("allowed"), ",") {
		if a = strings.TrimSpace(a); a != "" {
			allowed = append(allowed, strings.ToLower(a))
		}
	}

	rec, err := s.store.SaveFile(who, name, allowed, content)
	if err != nil {
		if errors.Is(err, store.ErrQuotaExceeded) {
			http.Error(w, "storage quota exceeded", http.StatusRequestEntityTooLarge)
			return
		}
		internalError(w, "save file: "+err.Error())
		return
	}
	_ = s.audit.Record(r.Context(), audit.ActionFileUpload, who,
		fmt.Sprintf("id=%s name=%s size=%d allowed=%d", rec.ID, name, rec.Size, len(allowed)))
	writeJSON(w, http.StatusOK, map[string]any{
		"id":          rec.ID,
		"access_code": rec.AccessCode,
		"filename":    rec.Filename,
		"size":        rec.Size,
	})
}

// handleFileDownload streams a file's content to an authorized account.
func (s *Server) handleFileDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	who := accountFrom(r.Context())
	// Route: /api/files/{id}/download -> ["api","files",id,"download"]
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 4 || parts[0] != "api" || parts[1] != "files" || parts[2] == "" || parts[3] != "download" {
		http.NotFound(w, r)
		return
	}
	id := parts[2]
	code := r.URL.Query().Get("code")
	rec, err := s.store.AuthorizeFileDownload(who, id, code)
	if err != nil {
		// Missing, not-permitted, and bad code all look the same.
		http.NotFound(w, r)
		return
	}
	content, err := s.store.GetFileContent(id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", rec.Filename))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(content)))
	_, _ = w.Write(content)
}

// sanitizeFilename strips path separators and control chars from an
// uploaded name; empty result becomes "file".
func sanitizeFilename(name string) string {
	name = strings.ReplaceAll(strings.ReplaceAll(name, "\\", "/"), "\x00", "")
	if i := strings.LastIndexByte(name, '/'); i >= 0 {
		name = name[i+1:]
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "file"
	}
	if len(name) > 255 {
		name = name[len(name)-255:]
	}
	return name
}
