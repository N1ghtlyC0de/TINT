// Package server define las rutas HTTP de social-core.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/reactions"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

const defaultAddr = ":8082"

// defaultOrigins son los orígenes del frontend en desarrollo (Vite).
const defaultOrigins = "localhost:5173,127.0.0.1:5173"

// ErrMissingSecret indica que no se configuró JWT_SECRET.
var ErrMissingSecret = errors.New("JWT_SECRET es obligatorio")

// Addr resuelve la dirección de escucha a partir del entorno.
func Addr(getenv func(string) string) string {
	if addr := getenv("SOCIAL_CORE_ADDR"); addr != "" {
		return addr
	}
	return defaultAddr
}

// Run arranca el servidor HTTP y bloquea hasta que falle.
func Run(getenv func(string) string) error {
	if getenv("JWT_SECRET") == "" {
		return ErrMissingSecret // falla cerrado: nunca verificar con clave vacía
	}
	addr := Addr(getenv)
	deps := DefaultDeps(getenv)
	log.Printf("social-core escuchando en %s", addr)
	return http.ListenAndServe(addr, NewRouterWithDeps(deps))
}

// DefaultDeps cablea memoria o Redis según REDIS_URL.
func DefaultDeps(getenv func(string) string) *Deps {
	hub := chat.NewHub()
	var history chat.Store = chat.NewMemoryStore(0)
	var store *chat.RedisStore
	if url := getenv("REDIS_URL"); url != "" {
		if rs, err := chat.NewRedisStore(url, 0, 0); err == nil {
			history = rs
			store = rs
		}
	}
	d := &Deps{
		Hub:               hub,
		History:           history,
		JWTSecret:         getenv("JWT_SECRET"),
		JWTIssuer:         or(getenv("JWT_ISSUER"), auth.DefaultIssuer),
		JWTAudience:       or(getenv("JWT_AUDIENCE"), auth.DefaultAudience),
		FirebaseProjectID: getenv("FIREBASE_PROJECT_ID"),
		HostKeys:          auth.NewGoogleCerts("", nil),
		AllowedOrigins:    splitList(or(getenv("ALLOWED_ORIGINS"), defaultOrigins)),
		ReactionBuckets:   reactions.NewBuckets(),
	}
	if store != nil {
		st := store
		d.Publish = func(ctx context.Context, roomID string, msg socialevent.ChatMessage) error {
			return st.Publish(ctx, roomID, msg)
		}
		d.Subscribe = func(ctx context.Context, roomID string) (<-chan chat.Inbound, func()) {
			return st.Subscribe(ctx, roomID)
		}
		d.IsRevoked = st.IsRevoked
		d.PublishReaction = st.PublishReaction
		d.Track = func(ctx context.Context, roomID string, length int, eventID string, occurredAt time.Time) {
			go func() {
				tctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
				defer cancel()
				_ = st.TrackChat(tctx, socialevent.ChatMessage{
					EventID: eventID, RoomID: roomID, OccurredAt: occurredAt,
				}, length)
			}()
		}
	}
	return d
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

// NewRouter construye el router HTTP del servicio.
func NewRouter() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz)
	return mux
}

func healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "service": "social-core"})
}
