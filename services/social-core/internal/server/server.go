// Package server define las rutas HTTP de social-core.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/analytics"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/polls"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/reactions"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/recap"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

const defaultAddr = ":8082"

// analyticsBuffer es la cola del emisor de analítica: si Redis se atrasa
// más de esto, los eventos se descartan (y se cuentan) en vez de bloquear.
const analyticsBuffer = 4096

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
	if deps.analytics != nil {
		go deps.analytics.Run(context.Background())
	}
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
		d.PublishRaw = st.PublishRaw
		d.Polls = polls.NewStore(st.Client(), chat.HistoryTTL)
		rc := recap.NewStore(st.Client(), chat.HistoryTTL)
		d.Recap = rc
		d.OnPollCreated = func(ctx context.Context, roomID string) {
			_ = rc.RecordPoll(ctx, roomID)
		}
		d.useAnalytics(analytics.New(st.Client(), analyticsBuffer))
	}
	return d
}

// useAnalytics cablea el emisor: chat_message, presence y reaction. Sin
// emisor (modo memoria) los Track* quedan en nil y no se publica nada.
func (d *Deps) useAnalytics(em *analytics.Emitter) {
	d.analytics = em
	d.TrackChat = func(m analytics.ChatMessage) { em.EmitChat(m) }
	d.TrackPresence = func(p analytics.Presence) { em.EmitPresence(p) }
	d.TrackReaction = func(r analytics.Reaction) { em.EmitReaction(r) }
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
