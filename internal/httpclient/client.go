// Package httpclient is the gateway's thin HTTP client for talking to
// agentmail-server. It has one method per server endpoint, handles Basic auth,
// and decodes JSON responses. There is no retry, no caching, no state — each
// call is a standalone request, which keeps the gateway stateless apart from
// its access_code map.
package httpclient

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client talks to one agentmail-server origin.
type Client struct {
	baseURL string
	http    *http.Client
}

// New returns a client for the given server origin (e.g. http://127.0.0.1:8090).
func New(baseURL string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

// BaseURL returns the server origin this client talks to.
func (c *Client) BaseURL() string {
	return c.baseURL
}

// Error is returned for non-2xx responses, carrying the status and a snippet
// of the body for diagnostics.
type Error struct {
	Status int
	Body   string
}

func (e *Error) Error() string {
	return fmt.Sprintf("server returned %d: %s", e.Status, e.Body)
}

// --- response shapes ---

type RegisterResponse struct {
	Address  string `json:"address"`
	Password string `json:"password"`
}

type AuthenticateResponse struct {
	AccessCode string `json:"access_code"`
}

type SendResponse struct {
	MessageID string `json:"message_id"`
}

type MessageSummary struct {
	ID         string   `json:"id"`
	From       string   `json:"from"`
	To         []string `json:"to"`
	Subject    string   `json:"subject"`
	Preview    string   `json:"preview"`
	ReceivedAt int64    `json:"received_at"`
	Unread     bool     `json:"unread"`
}

type InboxResponse struct {
	Messages []MessageSummary `json:"messages"`
	Count    int              `json:"count"`
}

type MessageResponse struct {
	MessageID string `json:"message_id"`
	From      string `json:"from"`
	To        []string `json:"to"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
	ReceivedAt int64 `json:"received_at"`
}

// --- API methods ---

// Register creates an account. No auth required.
func (c *Client) Register(name string) (*RegisterResponse, error) {
	var out RegisterResponse
	err := c.do("POST", "/api/register", "", nil, map[string]any{"name": name}, &out)
	return &out, err
}

// VerifyPassword checks credentials. No auth required (it IS the credential
// check). Returns nil on success.
func (c *Client) VerifyPassword(address, password string) error {
	return c.do("POST", "/api/verify-password", "", nil, map[string]any{
		"address":  address,
		"password": password,
	}, nil)
}

// Send posts a message as authUser. authUser:authPass is sent as Basic auth;
// the server treats the authed user as the sender. public=true additionally
// writes a showcase copy (portal sample) — explicit sender opt-in.
func (c *Client) Send(authUser, authPass string, to []string, subject, body string, public bool) (*SendResponse, error) {
	var out SendResponse
	err := c.do("POST", "/api/send", basicAuth(authUser, authPass), nil, map[string]any{
		"to":      to,
		"subject": subject,
		"body":    body,
		"public":  public,
	}, &out)
	return &out, err
}

// Inbox lists the authed user's inbox.
func (c *Client) Inbox(authUser, authPass string, limit int) (*InboxResponse, error) {
	var out InboxResponse
	q := url.Values{}
	if limit > 0 {
		q.Set("limit", fmt.Sprintf("%d", limit))
	}
	err := c.do("GET", "/api/inbox", basicAuth(authUser, authPass), q, nil, &out)
	return &out, err
}

// GetMessage fetches one message by id for the authed user.
func (c *Client) GetMessage(authUser, authPass, id string) (*MessageResponse, error) {
	var out MessageResponse
	q := url.Values{}
	q.Set("id", id)
	err := c.do("GET", "/api/message", basicAuth(authUser, authPass), q, nil, &out)
	return &out, err
}

// InfoRaw calls /api/info?query=<query> and returns the raw JSON as a generic
// map. For admin-only queries (accounts, audit), pass authUser/authPass; for
// public queries, pass empty strings.
func (c *Client) InfoRaw(authUser, authPass, query string) (map[string]any, error) {
	var out map[string]any
	q := url.Values{}
	q.Set("query", query)
	authHeader := ""
	if authUser != "" {
		authHeader = basicAuth(authUser, authPass)
	}
	err := c.do("GET", "/api/info", authHeader, q, nil, &out)
	return out, err
}

// AccountInfoRaw calls the account-scoped /api/account/info?query=<query>
// endpoint and returns the raw JSON. Always requires account Basic auth
// (authUser/authPass). query is "self" (caller's own profile) or "directory"
// (public address book). Mirrors InfoRaw but for account-level queries.
func (c *Client) AccountInfoRaw(authUser, authPass, query string) (map[string]any, error) {
	var out map[string]any
	q := url.Values{}
	q.Set("query", query)
	err := c.do("GET", "/api/account/info", basicAuth(authUser, authPass), q, nil, &out)
	return out, err
}

// UpdateProfile POSTs to /api/profile/self to set the caller's directory
// visibility and signature. Returns the raw JSON the server replies with
// ({"ok":true,"visible":...,"signature":...}).
func (c *Client) UpdateProfile(authUser, authPass string, visible bool, signature string) (map[string]any, error) {
	var out map[string]any
	err := c.do("POST", "/api/profile/self", basicAuth(authUser, authPass), nil, map[string]any{
		"visible":   visible,
		"signature": signature,
	}, &out)
	return out, err
}

// --- transport ---

func (c *Client) do(method, path, authHeader string, q url.Values, body any, out any) error {
	endpoint := c.baseURL + path
	if len(q) > 0 {
		endpoint += "?" + q.Encode()
	}
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal body: %w", err)
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, endpoint, reader)
	if err != nil {
		return err
	}
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		snippet := string(respBody)
		if len(snippet) > 300 {
			snippet = snippet[:300]
		}
		return &Error{Status: resp.StatusCode, Body: snippet}
	}
	if out != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("decode response: %w (body: %s)", err, string(respBody[:min(len(respBody), 200)]))
		}
	}
	return nil
}

func basicAuth(user, pass string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
