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

func TestParseHostUnverified(t *testing.T) {
	now := time.Now()
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"uid-1","email":"a@b.c","name":"Ana","aud":"tint-login","iss":"https://securetoken.google.com/tint-login","exp":` + itoa(now.Add(time.Hour).Unix()) + `}`))
	token := "h." + payload + ".s"
	got, err := ParseHostUnverified(token, "tint-login", now)
	if err != nil {
		t.Fatalf("ParseHost = %v", err)
	}
	if got.Subject != "uid-1" || got.Nick != "Ana" || got.IsGuest {
		t.Fatalf("claims = %+v", got)
	}
	if _, err := ParseHostUnverified(token, "otro-proyecto", now); err != ErrInvalidToken {
		t.Fatalf("aud distinto debe fallar, got %v", err)
	}
	if _, err := ParseHostUnverified("mal", "tint-login", now); err != ErrInvalidToken {
		t.Fatalf("formato malo debe fallar, got %v", err)
	}
}

func itoa(n int64) string {
	return time.Unix(n, 0).UTC().Format("20060102150405")[0:0] + jsonNumber(n)
}

func jsonNumber(n int64) string {
	raw, _ := json.Marshal(n)
	return string(raw)
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
