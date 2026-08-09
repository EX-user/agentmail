// Package config loads the agentmail-server configuration.
//
// The server reads a single TOML file that says where to listen, where to
// keep its bbolt database, what mail domain accounts live under, and the
// admin credentials used to read any account's mail for ops/audit.
package config

import (
	"fmt"
	"os"

	"github.com/BurntSushi/toml"
)

// Config is the top-level configuration object for agentmail-server.
type Config struct {
	Server  ServerConfig  `toml:"server"`
	Admin   AdminConfig   `toml:"admin"`
	Storage StorageConfig `toml:"storage"`
}

// ServerConfig describes the HTTP listener.
type ServerConfig struct {
	// Listen is the address:port the HTTP API binds, e.g. "127.0.0.1:8090".
	Listen string `toml:"listen"`
	// Domain is the mail domain accounts live under, e.g. "agentmail.local".
	Domain string `toml:"domain"`
}

// AdminConfig holds the administrator account. The admin is a regular account
// with the privilege to read any account's mail and the audit log over HTTP.
type AdminConfig struct {
	// Address of the admin account, e.g. "admin@agentmail.local".
	Address string `toml:"address"`
	// Password of the admin account. Set on first run to create the account.
	Password string `toml:"password"`
}

// StorageConfig describes where the bbolt database lives.
type StorageConfig struct {
	// DBPath is the path to the bbolt database file.
	DBPath string `toml:"db_path"`
}

// Load reads and validates the config file at path.
func Load(path string) (*Config, error) {
	cfg := defaults()

	if path != "" {
		if _, err := toml.DecodeFile(path, cfg); err != nil {
			return nil, fmt.Errorf("decode config %q: %w", path, err)
		}
	}

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func defaults() *Config {
	return &Config{
		Server: ServerConfig{
			Listen: "127.0.0.1:8090",
			Domain: "agentmail.local",
		},
		Storage: StorageConfig{
			DBPath: "agentmail.db",
		},
	}
}

func (c *Config) validate() error {
	if c.Server.Listen == "" {
		return fmt.Errorf("server.listen must be set")
	}
	if c.Server.Domain == "" {
		return fmt.Errorf("server.domain must be set")
	}
	if c.Storage.DBPath == "" {
		return fmt.Errorf("storage.db_path must be set")
	}
	return nil
}

// DefaultConfigPath returns the config path from the AGENTMAIL_CONFIG env var,
// or "" if unset.
func DefaultConfigPath() string {
	return os.Getenv("AGENTMAIL_CONFIG")
}
