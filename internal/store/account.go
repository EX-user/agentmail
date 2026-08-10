package store

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	bolt "go.etcd.io/bbolt"
	"golang.org/x/crypto/bcrypt"
)

// ErrAccountExists is returned when CreateAccount is called for an address
// that already exists.
var ErrAccountExists = errors.New("account already exists")

// ErrAccountNotFound is returned when an account lookup misses.
var ErrAccountNotFound = errors.New("account not found")

// ErrAccountDisabled is returned when a disabled account tries to authenticate.
var ErrAccountDisabled = errors.New("account disabled")

// Account is the stored record for a mail account.
type Account struct {
	UUID        string `json:"uuid"`
	Address     string `json:"address"`
	PasswordHash []byte `json:"password_hash"`
	IsAdmin     bool   `json:"is_admin"`
	Disabled    bool   `json:"disabled"`
	CreatedAt   int64  `json:"created_at"` // unix seconds
}

// CreateAccountResult is returned by CreateAccount.
type CreateAccountResult struct {
	Address  string
	Password string // plaintext, returned once to the caller
	UUID     string
}

// CreateAccount creates a new account with the given local-part under domain.
// It returns the generated address and plaintext password (available only
// here — the store keeps a bcrypt hash). Returns ErrAccountExists if the
// address is taken.
func (s *Store) CreateAccount(name, domain string, isAdmin bool) (*CreateAccountResult, error) {
	return s.createAccountWithPassword(name, domain, isAdmin, generatePassword(24))
}

// CreateAccountWithPassword is like CreateAccount but lets the caller supply
// the plaintext password (used by the setup wizard / bootstrap).
func (s *Store) CreateAccountWithPassword(name, domain string, isAdmin bool, password string) (*CreateAccountResult, error) {
	return s.createAccountWithPassword(name, domain, isAdmin, password)
}

func (s *Store) createAccountWithPassword(name, domain string, isAdmin bool, password string) (*CreateAccountResult, error) {
	name = strings.TrimSpace(name)
	address := name + "@" + domain

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("hash password: %w", err)
	}

	uuid := hexID()
	acc := Account{
		UUID:         uuid,
		Address:      address,
		PasswordHash: hash,
		IsAdmin:      isAdmin,
		CreatedAt:    s.now().Unix(),
	}
	val, err := json.Marshal(acc)
	if err != nil {
		return nil, err
	}

	err = s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bAccounts)
		if existing := b.Get([]byte(address)); existing != nil {
			return ErrAccountExists
		}
		return b.Put([]byte(address), val)
	})
	if err != nil {
		return nil, err
	}
	return &CreateAccountResult{Address: address, Password: password, UUID: uuid}, nil
}

// GetAccount loads an account by address.
func (s *Store) GetAccount(address string) (*Account, error) {
	var acc Account
	err := s.db.View(func(tx *bolt.Tx) error {
		val := tx.Bucket(bAccounts).Get([]byte(address))
		if val == nil {
			return ErrAccountNotFound
		}
		return json.Unmarshal(val, &acc)
	})
	if err != nil {
		return nil, err
	}
	return &acc, nil
}

// VerifyPassword checks that address/password is a valid credential pair.
// Returns ErrAccountNotFound if the address does not exist, ErrAccountDisabled
// if the account is disabled, nil on success, or a non-nil error for a wrong
// password.
func (s *Store) VerifyPassword(address, password string) error {
	acc, err := s.GetAccount(address)
	if err != nil {
		return err
	}
	if acc.Disabled {
		return ErrAccountDisabled
	}
	if err := bcrypt.CompareHashAndPassword(acc.PasswordHash, []byte(password)); err != nil {
		return fmt.Errorf("wrong password")
	}
	return nil
}

// ListAccounts returns every account (used by the admin). Admin accounts are
// included. Enabled accounts sort before disabled ones (stable within each
// group by address), so disabled accounts appear at the bottom of the panel.
func (s *Store) ListAccounts() ([]Account, error) {
	var out []Account
	err := s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(bAccounts).Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			var acc Account
			if err := json.Unmarshal(v, &acc); err != nil {
				continue
			}
			out = append(out, acc)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Stable sort: enabled first, then disabled; within each group by address.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Disabled != out[j].Disabled {
			return !out[i].Disabled // enabled (false) sorts before disabled (true)
		}
		return out[i].Address < out[j].Address
	})
	return out, nil
}

// ResetPassword overwrites an account's password hash with one derived from
// newPassword. It does NOT verify the old password — the caller (admin
// endpoint) has already authenticated. Used by the admin reset-password flow.
// Returns ErrAccountNotFound if the account does not exist.
func (s *Store) ResetPassword(address, newPassword string) error {
	if newPassword == "" {
		return fmt.Errorf("empty password")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bAccounts)
		val := b.Get([]byte(address))
		if val == nil {
			return ErrAccountNotFound
		}
		var acc Account
		if err := json.Unmarshal(val, &acc); err != nil {
			return err
		}
		acc.PasswordHash = hash
		newVal, err := json.Marshal(acc)
		if err != nil {
			return err
		}
		return b.Put([]byte(address), newVal)
	})
}

// SetAccountDisabled toggles an account's disabled flag. A disabled account
// cannot authenticate (VerifyPassword returns ErrAccountDisabled), so it can
// neither send nor read mail, but the account and its message history persist.
// Reversible via SetAccountDisabled(address, false).
func (s *Store) SetAccountDisabled(address string, disabled bool) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bAccounts)
		val := b.Get([]byte(address))
		if val == nil {
			return ErrAccountNotFound
		}
		var acc Account
		if err := json.Unmarshal(val, &acc); err != nil {
			return err
		}
		acc.Disabled = disabled
		newVal, err := json.Marshal(acc)
		if err != nil {
			return err
		}
		return b.Put([]byte(address), newVal)
	})
}

// GeneratePassword returns a cryptographically random password of length n
// from the URL-safe alphabet. Exported so the admin handler can generate a
// random password when the caller does not supply one.
func GeneratePassword(n int) string { return generatePassword(n) }

// EnsureAdmin creates the admin account if it does not already exist. Called
// at server startup from config.
func (s *Store) EnsureAdmin(address, password string) error {
	if _, err := s.GetAccount(address); err == nil {
		return nil // already exists
	} else if !errors.Is(err, ErrAccountNotFound) {
		return err
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash admin password: %w", err)
	}
	acc := Account{
		UUID:         hexID(),
		Address:      address,
		PasswordHash: hash,
		IsAdmin:      true,
		CreatedAt:    s.now().Unix(),
	}
	val, err := json.Marshal(acc)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bAccounts).Put([]byte(address), val)
	})
}

// BootstrapSystem initializes a fresh installation: creates the admin account
// with the given password, stores the domain, and marks the system initialized.
// This is called once (either from the setup wizard or as config migration).
// If already initialized it returns nil (idempotent).
//
// adminLocalPart is the local-part of the admin address (e.g. "admin"); the
// full address becomes adminLocalPart + "@" + domain.
func (s *Store) BootstrapSystem(adminLocalPart, adminPassword, domain string) error {
	if s.IsInitialized() {
		return nil // already bootstrapped; idempotent
	}
	adminAddress := adminLocalPart + "@" + domain
	if err := s.EnsureAdmin(adminAddress, adminPassword); err != nil {
		return fmt.Errorf("create admin: %w", err)
	}
	if err := s.SetDomain(domain); err != nil {
		return fmt.Errorf("set domain: %w", err)
	}
	return s.SetInitialized()
}

// generatePassword returns a cryptographically random password from the
// URL-safe alphabet.
func generatePassword(n int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic("store: crypto/rand failed during password generation: " + err.Error())
	}
	for i, b := range buf {
		buf[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(buf)
}
