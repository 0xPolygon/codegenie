package httpbin

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(req *http.Request) (*http.Response, error)

func (fn roundTripFunc) Do(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestClientBuildsGetRequest(t *testing.T) {
	client := NewClient(roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/get" {
			t.Fatalf("path = %s", req.URL.Path)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"args":{"name":"ada"},"headers":{},"url":"https://httpbin.org/get"}`)),
		}, nil
	}), DefaultBaseURL)

	result, err := client.GetJSON(context.Background(), map[string]string{"name": "ada"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Args["name"] != "ada" {
		t.Fatalf("name = %s", result.Args["name"])
	}
}
