package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestProfileSignatureTriState pins the signature-loss regression: a
// prefs-only (or visible-only) profile POST must NEVER touch the stored
// signature; only an explicitly sent signature field (including "") may.
func TestProfileSignatureTriState(t *testing.T) {
	ts, _ := newRegisterTestServer(t)

	post := func(body string) int {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/profile/self", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.SetBasicAuth("admin@test.example", "adminpassword1")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		io.Copy(io.Discard, resp.Body)
		return resp.StatusCode
	}
	getSig := func() string {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/profile/self", nil)
		req.SetBasicAuth("admin@test.example", "adminpassword1")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out struct {
			Signature string `json:"signature"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out.Signature
	}

	// Set a signature.
	if code := post(`{"signature":"sig-one"}`); code != http.StatusOK {
		t.Fatalf("set signature = %d, want 200", code)
	}
	if s := getSig(); s != "sig-one" {
		t.Fatalf("after set, signature = %q, want sig-one", s)
	}
	// THE REGRESSION: prefs-only POST used to wipe it to "".
	if code := post(`{"prefs":{"audio_autoplay":true}}`); code != http.StatusOK {
		t.Fatalf("prefs-only post = %d, want 200", code)
	}
	if s := getSig(); s != "sig-one" {
		t.Fatalf("after prefs-only post, signature = %q, want sig-one (kept)", s)
	}
	// Visible-only POST is equally harmless.
	if code := post(`{"visible":true}`); code != http.StatusOK {
		t.Fatalf("visible-only post = %d, want 200", code)
	}
	if s := getSig(); s != "sig-one" {
		t.Fatalf("after visible-only post, signature = %q, want sig-one (kept)", s)
	}
	// An explicit empty string still clears (that is a real user intent).
	if code := post(`{"signature":""}`); code != http.StatusOK {
		t.Fatalf("clear signature = %d, want 200", code)
	}
	if s := getSig(); s != "" {
		t.Fatalf("after explicit clear, signature = %q, want empty", s)
	}
}
