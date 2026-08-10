package server

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/agentmail/agentmail/internal/audit"
	"github.com/agentmail/agentmail/internal/config"
	"github.com/agentmail/agentmail/internal/store"
)

// WizardPort is the fixed port the setup wizard listens on. It is separate
// from the real server's listen address (which may not be known yet — the
// wizard collects it).
const WizardPort = "127.0.0.1:8848"

// WizardResult holds the outcome of a successful wizard run.
type WizardResult struct {
	Store    *store.Store
	Audit    *audit.Store
	Listen   string
	Domain   string
	DBPath   string
}

// RunWizard starts the setup wizard HTTP server on WizardPort, waits for the
// user to complete setup and click "launch", then returns. The returned store
// is already opened and bootstrapped (the wizard's /setup handler does
// store.Open + BootstrapSystem). It blocks until /launch is called or the
// HTTP server stops.
func RunWizard(cfg *config.Config) (*WizardResult, error) {
	w := &wizard{
		cfg:     cfg,
		doneCh:  make(chan struct{}),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", w.handleIndex)
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticSubFS))))
	mux.HandleFunc("/api/wizard-defaults", w.handleDefaults)
	mux.HandleFunc("/setup", w.handleSetup)
	mux.HandleFunc("/api/bootstrap-info", w.handleBootstrapInfo)
	mux.HandleFunc("/write-mcp-config", w.handleWriteMCPConfig)
	mux.HandleFunc("/launch", w.handleLaunch)

	srv := &http.Server{Addr: WizardPort, Handler: mux, ReadHeaderTimeout: 10e9}
	go func() {
		<-w.doneCh
		srv.Close()
	}()

	log.Printf("agentmail wizard: open http://%s/ in your browser", WizardPort)
	go openBrowser("http://" + WizardPort + "/")

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return nil, fmt.Errorf("wizard server: %w", err)
	}

	if w.result == nil {
		return nil, fmt.Errorf("wizard ended without completion")
	}
	return w.result, nil
}

type wizard struct {
	cfg    *config.Config
	result *WizardResult
	doneCh chan struct{}
}

func (w *wizard) handleIndex(resp http.ResponseWriter, req *http.Request) {
	if req.URL.Path != "/" {
		http.NotFound(resp, req)
		return
	}
	data, err := fs.ReadFile(staticSubFS, "wizard.html")
	if err != nil {
		// Fall back to index.html if wizard.html not yet created.
		data, err = fs.ReadFile(staticSubFS, "index.html")
		if err != nil {
			http.Error(resp, "setup page not found", http.StatusInternalServerError)
			return
		}
	}
	resp.Header().Set("Content-Type", "text/html; charset=utf-8")
	resp.Write(data)
}

// handleDefaults returns the default values for the wizard form (from config).
func (w *wizard) handleDefaults(resp http.ResponseWriter, req *http.Request) {
	writeJSON(resp, http.StatusOK, map[string]any{
		"db_path": w.cfg.Storage.DBPath,
		"listen":  w.cfg.Server.Listen,
		"domain":  w.cfg.Server.Domain,
	})
}

// handleSetup processes the wizard form: opens the db, bootstraps the system,
// and stores listen/domain. The store handle is kept for the caller.
func (w *wizard) handleSetup(resp http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(resp, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if w.result != nil {
		http.Error(resp, "already set up", http.StatusConflict)
		return
	}
	var body struct {
		DBPath   string `json:"db_path"`
		Listen   string `json:"listen"`
		Domain   string `json:"domain"`
		Password string `json:"admin_password"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSON(resp, http.StatusBadRequest, map[string]any{"error": "invalid body: " + err.Error()})
		return
	}
	body.DBPath = strings.TrimSpace(body.DBPath)
	body.Listen = strings.TrimSpace(body.Listen)
	body.Domain = strings.TrimSpace(body.Domain)
	if body.DBPath == "" || body.Listen == "" || body.Domain == "" || body.Password == "" {
		writeJSON(resp, http.StatusBadRequest, map[string]any{"error": "all fields are required"})
		return
	}
	if len(body.Password) < 8 {
		writeJSON(resp, http.StatusBadRequest, map[string]any{"error": "password must be at least 8 characters"})
		return
	}

	st, err := store.Open(body.DBPath)
	if err != nil {
		writeJSON(resp, http.StatusInternalServerError, map[string]any{"error": "open db: " + err.Error()})
		return
	}
	if st.IsInitialized() {
		st.Close()
		writeJSON(resp, http.StatusConflict, map[string]any{"error": "database is already initialized"})
		return
	}
	if err := st.BootstrapSystem("admin", body.Password, body.Domain); err != nil {
		st.Close()
		writeJSON(resp, http.StatusInternalServerError, map[string]any{"error": "bootstrap: " + err.Error()})
		return
	}
	if err := st.SetListen(body.Listen); err != nil {
		writeJSON(resp, http.StatusInternalServerError, map[string]any{"error": "set listen: " + err.Error()})
		return
	}
	auditStore, err := audit.New(st.DB())
	if err != nil {
		st.Close()
		writeJSON(resp, http.StatusInternalServerError, map[string]any{"error": "init audit: " + err.Error()})
		return
	}
	w.result = &WizardResult{
		Store:  st,
		Audit:  auditStore,
		Listen: body.Listen,
		Domain: body.Domain,
		DBPath: body.DBPath,
	}
	writeJSON(resp, http.StatusOK, map[string]any{
		"admin_address": "admin@" + body.Domain,
		"listen":        body.Listen,
		"domain":        body.Domain,
	})
}

// handleBootstrapInfo returns the collected config for MCP snippet generation.
func (w *wizard) handleBootstrapInfo(resp http.ResponseWriter, req *http.Request) {
	if w.result == nil {
		http.Error(resp, "not yet bootstrapped", http.StatusServiceUnavailable)
		return
	}
	gwPath := gatewayPath()
	writeJSON(resp, http.StatusOK, map[string]any{
		"listen":       w.result.Listen,
		"domain":       w.result.Domain,
		"gateway_path": gwPath,
		"server_url":   "http://" + w.result.Listen,
	})
}

// handleWriteMCPConfig writes the MCP client config file for the requested client.
//
//	POST /write-mcp-config {"client": "codex"|"zcode"|"opencode"}
func (w *wizard) handleWriteMCPConfig(resp http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(resp, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if w.result == nil {
		http.Error(resp, "not yet bootstrapped", http.StatusServiceUnavailable)
		return
	}
	var body struct{ Client string `json:"client"` }
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSON(resp, http.StatusBadRequest, map[string]any{"error": "invalid body"})
		return
	}
	gwPath := gatewayPath()
	serverURL := "http://" + w.result.Listen

	type target struct {
		path string
		content string
	}
	var t target
	switch body.Client {
	case "codex":
		home, _ := os.UserHomeDir()
		t.path = filepath.Join(home, ".codex", "config.toml")
		t.content = fmt.Sprintf(`[mcp_servers.agentmail]
command = "%s"
args = ["--server-url", "%s"]
`, escapeBackslash(gwPath), serverURL)
	case "zcode":
		home, _ := os.UserHomeDir()
		t.path = filepath.Join(home, ".zcode", "cli", "config.json")
		t.content = fmt.Sprintf(`{
  "mcp": {
    "servers": {
      "agentmail": {
        "type": "stdio",
        "command": "%s",
        "args": ["--server-url", "%s"],
        "enabled": true
      }
    }
  }
}
`, escapeBackslash(gwPath), serverURL)
	case "opencode":
		t.path = "opencode.json"
		t.content = fmt.Sprintf(`{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agentmail": {
      "type": "local",
      "command": ["%s", "--server-url", "%s"],
      "enabled": true
    }
  }
}
`, gwPath, serverURL)
	default:
		writeJSON(resp, http.StatusBadRequest, map[string]any{"error": "unknown client: " + body.Client})
		return
	}
	if err := os.MkdirAll(filepath.Dir(t.path), 0o755); err != nil {
		writeJSON(resp, http.StatusInternalServerError, map[string]any{"error": "create dir: " + err.Error()})
		return
	}
	if err := os.WriteFile(t.path, []byte(t.content), 0o600); err != nil {
		writeJSON(resp, http.StatusInternalServerError, map[string]any{"error": "write: " + err.Error()})
		return
	}
	writeJSON(resp, http.StatusOK, map[string]any{
		"client": body.Client,
		"path":   t.path,
		"written": true,
	})
}

// handleLaunch signals the wizard to shut down so main() can start the real server.
func (w *wizard) handleLaunch(resp http.ResponseWriter, req *http.Request) {
	if w.result == nil {
		http.Error(resp, "not yet bootstrapped", http.StatusServiceUnavailable)
		return
	}
	writeJSON(resp, http.StatusOK, map[string]any{"status": "launching"})
	go func() {
		// Small delay so the response is sent before the server closes.
		close(w.doneCh)
	}()
}

// gatewayPath returns the path to the agentmail-gateway binary next to the
// server executable.
func gatewayPath() string {
	exe, err := os.Executable()
	if err != nil {
		return "agentmail-gateway"
	}
	dir := filepath.Dir(exe)
	name := "agentmail-gateway"
	if runtime.GOOS == "windows" {
		name = "agentmail-gateway.exe"
	}
	return filepath.Join(dir, name)
}

func escapeBackslash(s string) string {
	return strings.ReplaceAll(s, `\`, `\\`)
}

// openBrowser tries to open the URL in the default browser. Best-effort.
func openBrowser(url string) {
	switch runtime.GOOS {
	case "windows":
		_ = exec.Command("cmd", "/c", "start", "", url).Start()
	case "darwin":
		_ = exec.Command("open", url).Start()
	default:
		_ = exec.Command("xdg-open", url).Start()
	}
}
