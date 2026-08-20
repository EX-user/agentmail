package server

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agentmail/agentmail/internal/audit"
	"github.com/agentmail/agentmail/internal/config"
	"github.com/agentmail/agentmail/internal/store"
)

// newRegisterTestServer boots a fully initialized server backed by a
// temp store (admin bootstrapped, domain test.example).
func newRegisterTestServer(t *testing.T) (*httptest.Server, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.DB().Close() })
	if err := st.BootstrapSystem("admin", "adminpassword1", "test.example"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	a, err := audit.New(st.DB())
	if err != nil {
		t.Fatalf("open audit: %v", err)
	}
	ts := httptest.NewServer(New(st, a, &config.Config{}).Handler())
	t.Cleanup(ts.Close)
	return ts, st
}

// TestRegisterPasswordlessGatedByRandomToggle pins the retirement of the
// one-click random register: the passwordless path is 403 by default,
// works only while the admin debug toggle is on, and password register is
// never affected.
func TestRegisterPasswordlessGatedByRandomToggle(t *testing.T) {
	ts, st := newRegisterTestServer(t)

	post := func(body string) int {
		t.Helper()
		resp, err := http.Post(ts.URL+"/api/register", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("post register: %v", err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}

	// Default OFF (superior directive: the mechanism retired).
	if code := post(`{"name":"pwless-default"}`); code != http.StatusForbidden {
		t.Fatalf("passwordless register default = %d, want 403", code)
	}
	// Admin re-enables the debug path -> works again.
	if err := st.SetRandomRegisterEnabled(true); err != nil {
		t.Fatalf("enable: %v", err)
	}
	if code := post(`{"name":"pwless-debug"}`); code != http.StatusOK {
		t.Fatalf("passwordless register with toggle on = %d, want 200", code)
	}
	// Password register is unaffected in either state.
	if code := post(`{"name":"normal-account","password":"password123"}`); code != http.StatusOK {
		t.Fatalf("password register = %d, want 200", code)
	}
	// Toggle back off -> gate returns.
	if err := st.SetRandomRegisterEnabled(false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if code := post(`{"name":"pwless-again"}`); code != http.StatusForbidden {
		t.Fatalf("passwordless register after disable = %d, want 403", code)
	}
}
