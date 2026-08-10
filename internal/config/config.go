// Package config loads the agentmail-server configuration.
//
// The TOML file holds only runtime settings that the server reads on every
// start: where to listen and where the bbolt database lives. First-time
// initialization (mail domain, admin password) is handled by the setup wizard
// and persisted in bbolt — it is NOT configured here.
package config

import (
	"fmt"
	"os"

	"github.com/BurntSushi/toml"
)

// Config is the top-level configuration object for agentmail-server.
type Config struct {
	Server  ServerConfig  `toml:"server"`
	Storage StorageConfig `toml:"storage"`
}

// ServerConfig describes the HTTP listener.
type ServerConfig struct {
	// Listen is the address:port the HTTP API binds, e.g. "127.0.0.1:8090".
	Listen string `toml:"listen"`
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
