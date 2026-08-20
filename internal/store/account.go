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
	// Visible controls whether the account appears in the public directory
	// (query=directory). Defaults to false; old records missing this field
	// unmarshal to false, so no data migration is needed.
	Visible bool `json:"visible"`
	// Signature is a short user-supplied tagline shown next to the address in
	// the public directory. Empty by default.
	Signature string `json:"signature"`
	// Prefs holds small per-account UI preferences ({"audio_autoplay":
	// false, "image_preview": true}). Nil on old records — readers treat
	// nil as all-defaults, no migration needed. Keys are whitelist-
	// validated at the API edge; the store accepts whatever map it is
	// given (it never interprets the contents).
	Prefs map[string]any `json:"prefs,omitempty"`
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

// ErrWrongPassword is returned by ChangePassword when the old password does not
// match the stored hash.
var ErrWrongPassword = errors.New("wrong password")

// ChangePassword verifies oldPassword against the stored hash and, on success,
// replaces it with one derived from newPassword. Returns ErrWrongPassword if
// the old password is incorrect, or ErrAccountNotFound if the account is gone.
// newPassword length is enforced (>= MinPasswordLength); empty is rejected.
const MinPasswordLength = 8

func (s *Store) ChangePassword(address, oldPassword, newPassword string) error {
	if len(newPassword) < MinPasswordLength {
		return fmt.Errorf("new password must be at least %d characters", MinPasswordLength)
	}
	// Verify the old password first (do this outside the write tx so we don't
	// hold a write lock for a bcrypt compare).
	if err := s.VerifyPassword(address, oldPassword); err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return ErrAccountNotFound
		}
		return ErrWrongPassword
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

// UpdateProfile sets an account's directory visibility and signature. The
// caller is responsible for trimming/length-limiting signature. Returns
// ErrAccountNotFound if the account does not exist.
func (s *Store) UpdateProfile(address string, visible bool, signature string) error {
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
		acc.Visible = visible
		acc.Signature = signature
		newVal, err := json.Marshal(acc)
		if err != nil {
			return err
		}
		return b.Put([]byte(address), newVal)
	})
}

// UpdatePrefs merges the given preference keys into the account's stored
// Prefs map (existing keys not mentioned are kept; a nil value for a key
// removes it). The API layer whitelist-validates keys and value types;
// the store just persists the map.
func (s *Store) UpdatePrefs(address string, prefs map[string]any) error {
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
		if acc.Prefs == nil {
			acc.Prefs = map[string]any{}
		}
		for k, v := range prefs {
			if v == nil {
				delete(acc.Prefs, k)
				continue
			}
			acc.Prefs[k] = v
		}
		if len(acc.Prefs) == 0 {
			acc.Prefs = nil // keep old records byte-identical when empty
		}
		newVal, err := json.Marshal(acc)
		if err != nil {
			return err
		}
		return b.Put([]byte(address), newVal)
	})
}

// ListVisibleAccounts returns every account with Visible == true, sorted by
// address. Disabled accounts are excluded even if marked visible (a disabled
// account should not advertise itself). Used to build the public directory.
func (s *Store) ListVisibleAccounts() ([]Account, error) {
	var out []Account
	err := s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(bAccounts).Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			var acc Account
			if err := json.Unmarshal(v, &acc); err != nil {
				continue
			}
			if acc.Visible && !acc.Disabled {
				out = append(out, acc)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Address < out[j].Address
	})
	return out, nil
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

// TeamMember is one provisioned account in a team registration.
type TeamMember struct {
	Address  string `json:"address"`
	Password string `json:"password"`
}

// RegisterTeam provisions an owner account plus teamSize subordinate
// bot accounts and their declare edges in ONE transaction (crash = nothing
// half-created). team_size counts MEMBERS ONLY — the owner is extra
// (architect ruling: default 3 = 1 owner + 3 members; 10 = the subordinate
// cap). The caller validates username/password shape; the store
// enforces uniqueness and names members bot-<8random>. Passwords are
// generated (owner uses the caller-supplied one).
func (s *Store) RegisterTeam(username, domain, password string, teamSize int) (*TeamMember, *[]TeamMember, error) {
	if teamSize < 1 || teamSize > 10 {
		return nil, nil, fmt.Errorf("team_size must be 1-10")
	}
	ownerAddr := username + "@" + domain
	ownerHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, nil, fmt.Errorf("hash password: %w", err)
	}
	now := s.now().Unix()
	owner := TeamMember{Address: ownerAddr, Password: password}
	var members []TeamMember

	err = s.db.Update(func(tx *bolt.Tx) error {
		ab := tx.Bucket(bAccounts)
		sb := tx.Bucket(bSubs)
		if ab.Get([]byte(ownerAddr)) != nil {
			return ErrAccountExists
		}
		acc := Account{UUID: hexID(), Address: ownerAddr, PasswordHash: ownerHash, CreatedAt: now}
		val, err := json.Marshal(acc)
		if err != nil {
			return err
		}
		if err := ab.Put([]byte(ownerAddr), val); err != nil {
			return err
		}
		// Members: bot-<8random>, each declared under the owner.
		for i := 0; i < teamSize; i++ {
			var name string
			ok := false
			for attempt := 0; attempt < 5; attempt++ {
				name = "bot-" + generatePassword(8)
				if ab.Get([]byte(name+"@"+domain)) == nil {
					ok = true
					break
				}
			}
			if !ok {
				return fmt.Errorf("could not allocate member name")
			}
			pw := generatePassword(24)
			hash, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
			if err != nil {
				return err
			}
			mAddr := name + "@" + domain
			mAcc := Account{UUID: hexID(), Address: mAddr, PasswordHash: hash, CreatedAt: now}
			mVal, err := json.Marshal(mAcc)
			if err != nil {
				return err
			}
			if err := ab.Put([]byte(mAddr), mVal); err != nil {
				return err
			}
			rec, _ := json.Marshal(SubRecord{Scope: "both", CreatedAt: now})
			if err := sb.Put(subKey(ownerAddr, mAddr), rec); err != nil {
				return err
			}
			members = append(members, TeamMember{Address: mAddr, Password: pw})
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return &owner, &members, nil
}
