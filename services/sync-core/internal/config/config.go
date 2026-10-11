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

// defaultOrigins acepta el servidor de Vite tanto en localhost como en
// 127.0.0.1: el navegador envía el Origin tal como se escribió la URL.
const defaultOrigins = "localhost:5173,127.0.0.1:5173"

// Config agrupa la configuración del servicio.
type Config struct {
	Addr           string
	RedisURL       string
	JWTSecret      string // compartido con identity-api (tokens HS256)
	JWTIssuer      string
	JWTAudience    string
	AllowedOrigins []string      // patrones de host para el handshake WS
	RoomTTL        time.Duration // periodo de gracia de la sala (REQ-07)
	HandoffAfter   time.Duration // sin host durante este tiempo, se delega el control
}

// Load lee la configuración usando getenv (inyectable en pruebas).
func Load(getenv func(string) string) (Config, error) {
	c := Config{
		Addr:           or(getenv("SYNC_CORE_ADDR"), ":8080"),
		RedisURL:       or(getenv("REDIS_URL"), "redis://localhost:6379"),
		JWTSecret:      getenv("JWT_SECRET"),
		JWTIssuer:      or(getenv("JWT_ISSUER"), "tint-identity"),
		JWTAudience:    or(getenv("JWT_AUDIENCE"), "tint:room"),
		AllowedOrigins: splitList(or(getenv("ALLOWED_ORIGINS"), defaultOrigins)),
		RoomTTL:        12 * time.Hour,
		HandoffAfter:   5 * time.Minute,
	}
	if c.JWTSecret == "" {
		return Config{}, ErrMissingSecret
	}
	for name, dst := range map[string]*time.Duration{"ROOM_TTL": &c.RoomTTL, "CONTROL_HANDOFF_AFTER": &c.HandoffAfter} {
		if err := duration(getenv(name), name, dst); err != nil {
			return Config{}, err
		}
	}
	return c, nil
}

// duration interpreta una duración positiva opcional.
func duration(raw, name string, dst *time.Duration) error {
	if raw == "" {
		return nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return fmt.Errorf("%s inválido %q: debe ser una duración positiva", name, raw)
	}
	*dst = d
	return nil
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
