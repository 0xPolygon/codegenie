package httpbin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const DefaultBaseURL = "https://httpbin.org"

type Doer interface {
	Do(req *http.Request) (*http.Response, error)
}

type Client struct {
	baseURL    string
	httpClient Doer
	timeout    time.Duration
}

type AnythingResponse struct {
	Args    map[string]string `json:"args"`
	Data    string            `json:"data"`
	Headers map[string]string `json:"headers"`
	Method  string            `json:"method"`
	URL     string            `json:"url"`
}

func NewClient(httpClient Doer, baseURL string) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{
		baseURL:    baseURL,
		httpClient: httpClient,
		timeout:    10 * time.Second,
	}
}

func (c *Client) GetJSON(ctx context.Context, query map[string]string) (AnythingResponse, error) {
	req, err := c.newRequest(ctx, http.MethodGet, "/get", query, nil)
	if err != nil {
		return AnythingResponse{}, err
	}
	return c.decode(req)
}

func (c *Client) PostJSON(ctx context.Context, payload map[string]any) (AnythingResponse, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return AnythingResponse{}, err
	}
	req, err := c.newRequest(ctx, http.MethodPost, "/post", nil, bytes.NewReader(body))
	if err != nil {
		return AnythingResponse{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.decode(req)
}

func (c Client) Status(ctx context.Context, code int) error {
	req, err := c.newRequest(ctx, http.MethodGet, fmt.Sprintf("/status/%d", code), nil, nil)
	if err != nil {
		return err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != code {
		return fmt.Errorf("httpbin status %d", resp.StatusCode)
	}
	return nil
}

func (*Client) Version() string {
	return "fixture-v1"
}

func (c *Client) decode(req *http.Request) (AnythingResponse, error) {
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return AnythingResponse{}, err
	}
	defer resp.Body.Close()
	var out AnythingResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return AnythingResponse{}, err
	}
	return out, nil
}

func (c *Client) newRequest(ctx context.Context, method string, endpoint string, query map[string]string, body io.Reader) (*http.Request, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	u, err := url.Parse(c.baseURL)
	if err != nil {
		return nil, err
	}
	u.Path = endpoint
	values := u.Query()
	for key, value := range query {
		values.Set(key, value)
	}
	u.RawQuery = values.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	return req, nil
}
