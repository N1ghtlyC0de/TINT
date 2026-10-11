package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Con JWT_SECRET vacío se verificaba con clave vacía (cualquiera podía firmar
// guest tokens). Como sync-core, el servicio se niega a arrancar.
func TestRunRequiresJWTSecret(t *testing.T) {
	env := func(k string) string {
		if k == "SOCIAL_CORE_ADDR" {
			return "127.0.0.1:0"
		}
		return ""
	}
	done := make(chan error, 1)
	go func() { done <- Run(env) }()
	select {
	case err := <-done:
		if !errors.Is(err, ErrMissingSecret) {
			t.Fatalf("Run() = %v, want ErrMissingSecret", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run() arrancó sin JWT_SECRET")
	}
}

func TestHealthz(t *testing.T) {
	rec := httptest.NewRecorder()
	NewRouter().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body["status"] != "ok" || body["service"] != "social-core" {
		t.Errorf("unexpected body: %v", body)
	}
}

func TestHealthzRejectsPost(t *testing.T) {
	rec := httptest.NewRecorder()
	NewRouter().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/healthz", nil))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

func TestAddr(t *testing.T) {
	empty := func(string) string { return "" }
	if got := Addr(empty); got != defaultAddr {
		t.Errorf("Addr() = %q, want %q", got, defaultAddr)
	}
	custom := func(string) string { return ":9999" }
	if got := Addr(custom); got != ":9999" {
		t.Errorf("Addr() = %q, want :9999", got)
	}
}

func TestRunFailsOnInvalidAddr(t *testing.T) {
	invalid := func(string) string { return "invalid-addr" }
	if err := Run(invalid); err == nil {
		t.Fatal("Run() with invalid addr should fail")
	}
}
