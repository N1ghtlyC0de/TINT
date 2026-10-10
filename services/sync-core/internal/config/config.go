// Package config resuelve la configuración de sync-core desde el entorno.
package config

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrMissingSecret indica que no se configuró JWT_SECRET.
var ErrMissingSecret = errors.New("JWT_SECRET es obligatorio")

// Config agrupa la configuración del servicio.
type Config struct {
	Addr           string
	RedisURL       string
	JWTSecret      string // compartido con identity-api (tokens HS256)
	JWTIssuer      string
	JWTAudience    string
	AllowedOrigins []string      // patrones de host para el handshake WS
	RoomTTL        time.Duration // periodo de gracia de la sala (REQ-07)
}

// Load lee la configuración usando getenv (inyectable en pruebas).
func Load(getenv func(string) string) (Config, error) {
	c := Config{
		Addr:           or(getenv("SYNC_CORE_ADDR"), ":8080"),
		RedisURL:       or(getenv("REDIS_URL"), "redis://localhost:6379"),
		JWTSecret:      getenv("JWT_SECRET"),
		JWTIssuer:      or(getenv("JWT_ISSUER"), "tint-identity"),
		JWTAudience:    or(getenv("JWT_AUDIENCE"), "tint:room"),
		AllowedOrigins: splitList(or(getenv("ALLOWED_ORIGINS"), "localhost:5173")),
		RoomTTL:        12 * time.Hour,
	}
	if c.JWTSecret == "" {
		return Config{}, ErrMissingSecret
	}
	if raw := getenv("ROOM_TTL"); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			return Config{}, fmt.Errorf("ROOM_TTL inválido %q: debe ser una duración positiva", raw)
		}
		c.RoomTTL = d
	}
	return c, nil
}

func or(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func splitList(raw string) []string {
	var out []string
	for _, p := range strings.Split(raw, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
