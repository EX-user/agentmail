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

	// Ensure the admin account exists (created on first run from config).
	if cfg.Admin.Address != "" && cfg.Admin.Password != "" {
		if err := st.EnsureAdmin(cfg.Admin.Address, cfg.Admin.Password); err != nil {
			fmt.Fprintf(os.Stderr, "agentmail-server: ensure admin: %v\n", err)
			os.Exit(1)
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
