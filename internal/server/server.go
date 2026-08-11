// Package server is agentmail-server's HTTP API. It exposes the message-store
// operations behind HTTP Basic auth: every mailbox-affecting endpoint
// authenticates as the acting account, so per-account isolation is enforced
// by the server (not by the gateway or by convention). The gateway holds no
// data and simply forwards Basic-authed requests.
package server

import (
	"context"
	"encoding/base64"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/agentmail/agentmail/internal/audit"
	"github.com/agentmail/agentmail/internal/config"
	"github.com/agentmail/agentmail/internal/store"
)

// Version is the agentmail-server version. Overridden at build time via
// -ldflags "-X github.com/agentmail/agentmail/internal/server.Version=v0.1.2".
var Version = "dev"

// MaxSignatureLen is the maximum number of characters allowed in an account's
// directory signature. Enforced in handleProfileSelf before persisting.
const MaxSignatureLen = 200

// rateWindow is a 1-hour sliding window counter.
type rateWindow struct {
	count       int
	bytes       int64
	windowStart time.Time
}

// Server wires the store and audit log to the HTTP router.
type Server struct {
	store    *store.Store
	audit    *audit.Store
	cfg      *config.Config

	// Rate limiters (in-memory, 1-hour sliding window).
	rateMu     sync.Mutex
	sendRates  map[string]*rateWindow // address -> send count window
	recvRates  map[string]*rateWindow // address -> byte receive window
}

// New builds a server with the given dependencies.
func New(s *store.Store, a *audit.Store, cfg *config.Config) *Server {
	return &Server{store: s, audit: a, cfg: cfg, sendRates: make(map[string]*rateWindow), recvRates: make(map[string]*rateWindow)}
}

// domain returns the effective mail domain: the value persisted in bbolt
// (set by the setup wizard).
func (s *Server) domain() string {
	return s.store.GetDomain()
}

// adminAddress returns the admin account address for the current domain.
// The admin local-part is fixed as "admin".
func (s *Server) adminAddress() string {
	return "admin@" + s.domain()
}

// --- rate limiting (1-hour sliding window, in-memory) ---

// checkSendRate returns an error if the account has exceeded its hourly send
// limit. On success it increments the counter.
func (s *Server) checkSendRate(address string) error {
	limit := s.store.GetSendRateLimit()
	s.rateMu.Lock()
	defer s.rateMu.Unlock()
	w := s.sendRates[address]
	now := time.Now()
	if w == nil || now.Sub(w.windowStart) >= time.Hour {
		w = &rateWindow{windowStart: now}
		s.sendRates[address] = w
	}
	if w.count >= limit {
		return fmt.Errorf("send rate limit exceeded (%d/hour)", limit)
	}
	w.count++
	return nil
}

// checkRecvRate returns false if the account has exceeded its hourly byte
// receive limit for bodyLen additional bytes. On true it updates the counter.
func (s *Server) checkRecvRate(address string, bodyLen int64) bool {
	limit := s.store.GetByteRateLimit()
	s.rateMu.Lock()
	defer s.rateMu.Unlock()
	w := s.recvRates[address]
	now := time.Now()
	if w == nil || now.Sub(w.windowStart) >= time.Hour {
		w = &rateWindow{windowStart: now}
		s.recvRates[address] = w
	}
	if w.bytes+bodyLen > limit {
		return false // would exceed
	}
	w.bytes += bodyLen
	return true
}

// Handler returns the HTTP handler for the API.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealthz)

	// Setup + status — always available (no auth, no initialization required).
	mux.HandleFunc("/setup", s.handleSetup)
	mux.HandleFunc("/api/status", s.handleStatus)

	// Public API (no auth) — requires initialization.
	mux.HandleFunc("/api/register", s.requireInitialized(s.handleRegister))
	mux.HandleFunc("/api/verify-password", s.requireInitialized(s.handleVerifyPassword))
	mux.HandleFunc("/api/info", s.handleInfo)

	// Authed API (account Basic auth) — requires initialization.
	mux.HandleFunc("/api/send", s.requireInitialized(s.requireAccount(s.handleSend)))
	mux.HandleFunc("/api/inbox", s.requireInitialized(s.requireAccount(s.handleInbox)))
	mux.HandleFunc("/api/message", s.requireInitialized(s.requireAccount(s.handleMessage)))
	mux.HandleFunc("/api/profile/self", s.requireInitialized(s.requireAccount(s.handleProfileSelf)))
	mux.HandleFunc("/api/account/info", s.requireInitialized(s.requireAccount(s.handleAccountInfo)))

	// Admin API (admin Basic auth) — requires initialization.
	mux.HandleFunc("/admin/messages", s.requireInitialized(s.requireAdmin(s.handleAdminMessages)))
	mux.HandleFunc("/admin/sent", s.requireInitialized(s.requireAdmin(s.handleAdminSent)))
	mux.HandleFunc("/admin/message", s.requireInitialized(s.requireAdmin(s.handleAdminMessage)))
	mux.HandleFunc("/admin/accounts", s.requireInitialized(s.requireAdmin(s.handleAdminAccounts)))
	mux.HandleFunc("/admin/audit", s.requireInitialized(s.requireAdmin(s.handleAdminAudit)))
	mux.HandleFunc("/admin/stats", s.requireInitialized(s.requireAdmin(s.handleAdminStats)))
	mux.HandleFunc("/admin/reset-password", s.requireInitialized(s.requireAdmin(s.handleAdminResetPassword)))
	mux.HandleFunc("/admin/set-disabled", s.requireInitialized(s.requireAdmin(s.handleAdminSetDisabled)))
	mux.HandleFunc("/admin/send", s.requireInitialized(s.requireAdmin(s.handleAdminSend)))
	mux.HandleFunc("/admin/settings", s.requireInitialized(s.requireAdmin(s.handleAdminSettings)))
	mux.HandleFunc("/admin/set-registration", s.requireInitialized(s.requireAdmin(s.handleAdminSetRegistration)))
	mux.HandleFunc("/admin/set-directory-listed", s.requireInitialized(s.requireAdmin(s.handleAdminSetDirectoryListed)))
	mux.HandleFunc("/admin/set-limits", s.requireInitialized(s.requireAdmin(s.handleAdminSetLimits)))

	// Admin web panel: static files under /static/*, plus the index page at "/".
	// These are always served (the panel JS checks /api/status to decide
	// whether to show the setup wizard or the normal UI).
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticSubFS))))
	mux.HandleFunc("/", s.serveIndex)

	return mux
}

// requireInitialized gates a handler on the system being bootstrapped. Before
// initialization, every data endpoint returns 503 so the only paths that work
// are /healthz, /setup, /api/status, and the static panel (which shows the
// setup wizard).
func (s *Server) requireInitialized(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.store.IsInitialized() {
			http.Error(w, "not initialized", http.StatusServiceUnavailable)
			return
		}
		h(w, r)
	}
}

// serveIndex returns the embedded index.html for the panel root. It is the
// unauthenticated entry point: the browser will prompt for Basic auth when the
// page's first admin fetch runs.
func (s *Server) serveIndex(w http.ResponseWriter, r *http.Request) {
	// Only serve the index at exactly "/"; anything else is a 404.
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	data, err := fs.ReadFile(staticSubFS, "index.html")
	if err != nil {
		http.Error(w, "index not found", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(data)
}

// ListenAndServe starts the HTTP server. Blocks until ctx is cancelled.
func (s *Server) ListenAndServe(ctx context.Context) error {
	srv := &http.Server{
		Addr:              s.cfg.Server.Listen,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shut)
	}()
	return srv.ListenAndServe()
}

// requireAccount wraps a handler so that it only runs after a valid non-admin
// account credential is presented via HTTP Basic auth. The authenticated
// address is passed to the handler via the request context.
func (s *Server) requireAccount(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		address, ok := s.basicAuthAccount(w, r)
		if !ok {
			return // already wrote 401
		}
		h.ServeHTTP(w, r.WithContext(withAccount(r.Context(), address)))
	}
}

// requireAdmin wraps a handler so that it only runs for the configured admin
// credential.
func (s *Server) requireAdmin(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.basicAuthAdmin(w, r) {
			return
		}
		h.ServeHTTP(w, r)
	}
}

// basicAuthAccount validates a Basic auth header against a real account and
// returns the address on success. Writes 401 and returns false on failure.
func (s *Server) basicAuthAccount(w http.ResponseWriter, r *http.Request) (string, bool) {
	user, pass, ok := parseBasicAuth(r.Header.Get("Authorization"))
	if !ok {
		unauthorized(w)
		return "", false
	}
	// The admin credential also satisfies account auth (the admin is an
	// account), but admin-only endpoints use requireAdmin separately.
	if err := s.store.VerifyPassword(user, pass); err != nil {
		unauthorized(w)
		return "", false
	}
	return user, true
}

// basicAuthAdmin validates a Basic auth header against a stored admin account.
// Admin credentials are looked up in bbolt (not the config file), so an admin
// who resets their password via the panel keeps working after the change and
// across restarts. The config file's [admin] section only seeds the initial
// admin account at first startup (see EnsureAdmin).
//
// A credential pair is admin-valid iff:
//   - the account exists in bbolt,
//   - the bcrypt hash matches, and
//   - the account has IsAdmin == true.
func (s *Server) basicAuthAdmin(w http.ResponseWriter, r *http.Request) bool {
	user, pass, ok := parseBasicAuth(r.Header.Get("Authorization"))
	if !ok {
		unauthorized(w)
		return false
	}
	acc, err := s.store.GetAccount(user)
	if err != nil {
		unauthorized(w)
		return false
	}
	if err := bcryptCompare(acc.PasswordHash, []byte(pass)); err != nil {
		unauthorized(w)
		return false
	}
	if !acc.IsAdmin {
		unauthorized(w)
		return false
	}
	return true
}

// --- helpers ---

type ctxKey int

const accountKey ctxKey = 1

func withAccount(ctx context.Context, address string) context.Context {
	return context.WithValue(ctx, accountKey, address)
}

func accountFrom(ctx context.Context) string {
	v, _ := ctx.Value(accountKey).(string)
	return v
}

// parseBasicAuth splits an "Authorization: Basic ..." header.
func parseBasicAuth(header string) (user, pass string, ok bool) {
	const prefix = "Basic "
	if !strings.HasPrefix(header, prefix) {
		return "", "", false
	}
	dec, err := base64.StdEncoding.DecodeString(strings.TrimSpace(header[len(prefix):]))
	if err != nil {
		return "", "", false
	}
	parts := strings.SplitN(string(dec), ":", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Basic realm="agentmail"`)
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}

// bcryptCompare is a thin wrapper kept here so the server package does not
// reach into store internals for the admin auth check.
func bcryptCompare(hash, password []byte) error {
	return bcrypt.CompareHashAndPassword(hash, password)
}
