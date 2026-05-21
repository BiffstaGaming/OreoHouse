package adminui

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandler_ServesIndex(t *testing.T) {
	srv := httptest.NewServer(http.StripPrefix("/admin/", Handler()))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/admin/")
	if err != nil {
		t.Fatalf("GET /admin/: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if !strings.Contains(string(body), "OreoHouse Admin") {
		end := len(body)
		if end > 200 {
			end = 200
		}
		t.Errorf("expected page title in body, got %q", string(body)[:end])
	}
}

func TestHandler_ServesAppJS(t *testing.T) {
	srv := httptest.NewServer(http.StripPrefix("/admin/", Handler()))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/admin/app.js")
	if err != nil {
		t.Fatalf("GET /admin/app.js: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if !strings.Contains(string(body), "oreohouse-admin-token") {
		t.Errorf("expected app.js to contain the token key constant")
	}
}

func TestHandler_404OnUnknown(t *testing.T) {
	srv := httptest.NewServer(http.StripPrefix("/admin/", Handler()))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/admin/nope.js")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404, got %d", resp.StatusCode)
	}
}

