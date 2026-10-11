// Package server define las rutas HTTP de social-core.
package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/reactions"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

const defaultAddr = ":8082"

// Addr resuelve la dirección de escucha a partir del entorno.
func Addr(getenv func(string) string) string {
	if addr := getenv("SOCIAL_CORE_ADDR"); addr != "" {
		return addr
	}
	return defaultAddr
}

// Run arranca el servidor HTTP y bloquea hasta que falle.
func Run(getenv func(string) string) error {
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
		FirebaseProjectID: getenv("FIREBASE_PROJECT_ID"),
		ReactionBuckets:   reactions.NewBuckets(),
	}
	if store != nil {
		st := store
		d.Publish = func(ctx context.Context, roomID string, msg socialevent.ChatMessage) error {
			return st.Publish(ctx, roomID, msg)
		}
		d.Subscribe = func(ctx context.Context, roomID string) (<-chan socialevent.ChatMessage, func()) {
			return st.Subscribe(ctx, roomID)
		}
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
