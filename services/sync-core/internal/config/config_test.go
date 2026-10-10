package config

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(env(map[string]string{"JWT_SECRET": "s3cr3t"}))
	if err != nil {
		t.Fatal(err)
	}
	want := Config{
		Addr:           ":8080",
		RedisURL:       "redis://localhost:6379",
		JWTSecret:      "s3cr3t",
		JWTIssuer:      "tint-identity",
		JWTAudience:    "tint:room",
		AllowedOrigins: []string{"localhost:5173"},
		RoomTTL:        12 * time.Hour,
	}
	if !reflect.DeepEqual(c, want) {
		t.Errorf("Load() =\n %+v\nwant\n %+v", c, want)
	}
}

func TestLoadOverrides(t *testing.T) {
	c, err := Load(env(map[string]string{
		"SYNC_CORE_ADDR":  ":9090",
		"REDIS_URL":       "redis://redis:6379/1",
		"JWT_SECRET":      "x",
		"JWT_ISSUER":      "iss",
		"JWT_AUDIENCE":    "aud",
		"ALLOWED_ORIGINS": "tint.app, localhost:5173 ,",
		"ROOM_TTL":        "30m",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != ":9090" || c.RedisURL != "redis://redis:6379/1" || c.JWTIssuer != "iss" || c.JWTAudience != "aud" || c.RoomTTL != 30*time.Minute {
		t.Errorf("overrides no aplicados: %+v", c)
	}
	if !reflect.DeepEqual(c.AllowedOrigins, []string{"tint.app", "localhost:5173"}) {
		t.Errorf("AllowedOrigins = %q", c.AllowedOrigins)
	}
}

func TestLoadErrors(t *testing.T) {
	if _, err := Load(env(nil)); !errors.Is(err, ErrMissingSecret) {
		t.Errorf("sin JWT_SECRET: err = %v", err)
	}
	if _, err := Load(env(map[string]string{"JWT_SECRET": "x", "ROOM_TTL": "doce"})); err == nil {
		t.Error("ROOM_TTL inválido debe fallar")
	}
	if _, err := Load(env(map[string]string{"JWT_SECRET": "x", "ROOM_TTL": "-1h"})); err == nil {
		t.Error("ROOM_TTL no positivo debe fallar")
	}
}
