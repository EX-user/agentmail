// Command agentmail-server is the persistent message store and HTTP API.
//
// It owns the bbolt database and serves all mailbox operations behind HTTP
// Basic auth. It has no concept of access codes or sessions — that lives in
// the gateway. One server process serves many agent sessions concurrently.
//
// Usage:
//
//	agentmail-server --config path/to/agentmail.toml
//
// If --config is omitted, AGENTMAIL_CONFIG is used.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/agentmail/agentmail/internal/audit"
	"github.com/agentmail/agentmail/internal/config"
	"github.com/agentmail/agentmail/internal/server"
	"github.com/agentmail/agentmail/internal/store"
)

func main() {
	configPath := flag.String("config", config.DefaultConfigPath(), "path to agentmail.toml")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "agentmail-server: load config: %v\n", err)
		os.Exit(2)
	}

	st, err := store.Open(cfg.Storage.DBPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "agentmail-server: open store: %v\n", err)
		os.Exit(1)
	}
	defer st.Close()

	auditStore, err := audit.New(st.DB())
	if err != nil {
		fmt.Fprintf(os.Stderr, "agentmail-server: init audit: %v\n", err)
		os.Exit(1)
	}

	// Bootstrap / migration logic.
	// - If already initialized (bbolt flag set): nothing to do.
	// - If NOT initialized but config has admin address+password and a domain:
	//   migrate from old-style config (auto-bootstrap, no wizard needed).
	// - If NOT initialized and config lacks admin/domain: the system starts
	//   in "uninitialized" mode and the setup wizard handles it on first
	//   browser visit.
	if !st.IsInitialized() {
		if cfg.Admin.Address != "" && cfg.Admin.Password != "" && cfg.Server.Domain != "" {
			// Old-style config present: auto-migrate. Extract the admin local-part
			// from the configured address (everything before "@").
			adminLocal := cfg.Admin.Address
			if at := strings.IndexByte(adminLocal, '@'); at > 0 {
				adminLocal = adminLocal[:at]
			}
			log.Printf("agentmail-server: migrating from config, bootstrapping (domain=%s)", cfg.Server.Domain)
			if err := st.BootstrapSystem(adminLocal, cfg.Admin.Password, cfg.Server.Domain, "12345678"); err != nil {
				fmt.Fprintf(os.Stderr, "agentmail-server: bootstrap from config: %v\n", err)
				os.Exit(1)
			}
		} else {
			log.Printf("agentmail-server: not initialized — setup wizard required (open the panel at http://%s/)", cfg.Server.Listen)
		}
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	srv := server.New(st, auditStore, cfg)
	log.Printf("agentmail-server listening on %s (domain %s)", cfg.Server.Listen, cfg.Server.Domain)
	if err := srv.ListenAndServe(ctx); err != nil && ctx.Err() == nil {
		log.Printf("agentmail-server: %v", err)
		os.Exit(1)
	}
}
