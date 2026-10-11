package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func signGuest(payload map[string]any, secret string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	raw, _ := json.Marshal(payload)
	body := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(header + "." + body))
	return header + "." + body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestVerifyGuestOKAndWrongRoom(t *testing.T) {
	now := time.Now()
	token := signGuest(map[string]any{
		"sub": "guest:1", "room_id": "r1", "role": "participant",
		"nick": "Invitado", "exp": now.Add(time.Hour).Unix(),
	}, "secret")
	got, err := VerifyGuest(token, "secret", "r1", now)
	if err != nil {
		t.Fatalf("VerifyGuest = %v", err)
	}
	if got.Subject != "guest:1" || !got.IsGuest || got.Nick != "Invitado" {
		t.Fatalf("claims = %+v", got)
	}
	if _, err := VerifyGuest(token, "secret", "otra", now); err != ErrWrongRoom {
		t.Fatalf("sala distinta debe dar ErrWrongRoom, got %v", err)
	}
	if _, err := VerifyGuest(token, "otra", "r1", now); err != ErrInvalidToken {
		t.Fatalf("firma mala debe dar ErrInvalidToken, got %v", err)
	}
	expired := signGuest(map[string]any{"sub": "g", "room_id": "r1", "exp": now.Add(-time.Hour).Unix()}, "secret")
	if _, err := VerifyGuest(expired, "secret", "r1", now); err != ErrExpired {
		t.Fatalf("expirado debe dar ErrExpired, got %v", err)
	}
}

func TestVerifyGuestRejectsEmptySecret(t *testing.T) {
	now := time.Now()
	token := signGuest(map[string]any{"sub": "g", "room_id": "r1", "exp": now.Add(time.Hour).Unix()}, "")
	if _, err := VerifyGuest(token, "", "r1", now); err != ErrInvalidToken {
		t.Fatalf("secreto vacío debe fallar cerrado, got %v", err)
	}
}

func TestBearerToken(t *testing.T) {
	got, err := BearerToken("Bearer abc", "")
	if err != nil || got != "abc" {
		t.Fatalf("header = %q, %v", got, err)
	}
	got, err = BearerToken("", "q123")
	if err != nil || got != "q123" {
		t.Fatalf("query = %q, %v", got, err)
	}
	if _, err := BearerToken("", ""); err != ErrMissingToken {
		t.Fatalf("sin token debe dar ErrMissingToken, got %v", err)
	}
}
