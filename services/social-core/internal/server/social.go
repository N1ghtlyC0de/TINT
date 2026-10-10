// Package server — endpoint WebSocket del Canal Social (/ws/social, solo chat).
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sync"
	"time"
	"unicode/utf8"

	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/reactions"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// Deps son las dependencias del endpoint social (inyectables en tests).
type Deps struct {
	Hub       *chat.Hub
	History   chat.Store
	Publish   func(ctx context.Context, roomID string, msg socialevent.ChatMessage) error
	Track     func(ctx context.Context, roomID string, messageLength int, eventID string, occurredAt time.Time)
	Subscribe func(ctx context.Context, roomID string) (<-chan socialevent.ChatMessage, func())
	// Auth
	JWTSecret         string
	FirebaseProjectID string
	// Utilidades
	Now       func() time.Time
	NewID     func() string
	ChatLimit *reactions.Limiter
	// Estado interno del relay compartido y dedup (ver relay.go).
	mu     sync.Mutex
	relays map[string]*roomRelay
	seen   *seenIDs
	// presence cuenta conexiones por sala y usuario para emitir un solo
	// aviso de entrada/salida aunque el usuario abra varias pestañas.
	presence map[string]map[string]int
}

// presenceJoin suma una conexión; true si es la primera del usuario en la sala.
func (d *Deps) presenceJoin(roomID, userID string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.presence == nil {
		d.presence = make(map[string]map[string]int)
	}
	users := d.presence[roomID]
	if users == nil {
		users = make(map[string]int)
		d.presence[roomID] = users
	}
	users[userID]++
	return users[userID] == 1
}

// presenceLeave resta una conexión; true si fue la última del usuario.
func (d *Deps) presenceLeave(roomID, userID string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	users := d.presence[roomID]
	if users == nil || users[userID] <= 0 {
		return false
	}
	users[userID]--
	if users[userID] > 0 {
		return false
	}
	delete(users, userID)
	if len(users) == 0 {
		delete(d.presence, roomID)
	}
	return true
}

func noticeText(nick string, kind socialevent.NoticeKind) string {
	if kind == socialevent.NoticeLeft {
		return nick + " salió del chat"
	}
	return nick + " entró al chat"
}

// emitNotice envía un aviso de presencia solo en vivo: no se guarda en el
// historial, no se publica a otras réplicas ni se registra en analítica.
func (d *Deps) emitNotice(roomID string, claims auth.Claims, kind socialevent.NoticeKind) {
	now := d.now()
	n := socialevent.Notice{
		EventID: d.newID(), Type: socialevent.TypeNotice, RoomID: roomID,
		UserID: claims.Subject, Nick: claims.Nick, Kind: kind,
		Text: noticeText(claims.Nick, kind), OccurredAt: now,
	}
	if err := n.Validate(); err != nil {
		return
	}
	raw, err := json.Marshal(n)
	if err != nil {
		return
	}
	if d.markSeen(n.EventID) {
		return
	}
	d.Hub.Broadcast(roomID, raw)
}

func (d *Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now().UTC()
}

func (d *Deps) newID() string {
	if d.NewID != nil {
		return d.NewID()
	}
	return newUUID()
}

// MountSocial registra GET /ws/social sobre mux.
func MountSocial(mux *http.ServeMux, d *Deps) {
	mux.HandleFunc("GET /ws/social", func(w http.ResponseWriter, r *http.Request) {
		handleSocial(w, r, d)
	})
}

// NewRouterWithDeps construye el router completo (healthz + social).
func NewRouterWithDeps(d *Deps) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz)
	MountSocial(mux, d)
	return mux
}

func writeError(ctx context.Context, c *websocket.Conn, code, ref string) {
	raw, _ := json.Marshal(socialevent.ErrorEnvelope{Type: socialevent.TypeError, Code: code, EventIDRef: ref})
	_ = c.Write(ctx, websocket.MessageText, raw)
}

func handleSocial(w http.ResponseWriter, r *http.Request, d *Deps) {
	ctx := r.Context()
	roomID := r.URL.Query().Get("room_id")
	if roomID == "" {
		http.Error(w, "room_id es obligatorio", http.StatusBadRequest)
		return
	}
	token, err := auth.BearerToken(r.Header.Get("Authorization"), r.URL.Query().Get("token"))
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	now := d.now()
	claims, guestErr := auth.VerifyGuest(token, d.JWTSecret, roomID, now)
	if guestErr != nil {
		if guestErr == auth.ErrWrongRoom {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		host, hostErr := auth.ParseHostUnverified(token, d.FirebaseProjectID, now)
		if hostErr != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		claims = host
	}

	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
		return
	}
	defer c.Close(websocket.StatusNormalClosure, "")
	c.SetReadLimit(8 * 1024)

	connID := d.newID()
	send := make(chan []byte, 64)
	d.Hub.Join(roomID, connID, send)
	defer d.Hub.Leave(roomID, connID)

	// Relay multirréplica compartido: una sola suscripción por sala y réplica.
	// Sin esto cada conexión reemitía el eco de Redis (entrega 1+N veces).
	if d.Subscribe != nil {
		release := d.acquireRelay(roomID)
		defer release()
	}

	// Historial corto como primer mensaje.
	recent, err := d.History.Recent(ctx, roomID, socialevent.HistoryLimit)
	if err != nil {
		recent = nil
	}
	if recent == nil {
		recent = []socialevent.ChatMessage{}
	}
	histRaw, _ := json.Marshal(socialevent.HistoryEnvelope{Type: socialevent.TypeHistory, RoomID: roomID, Messages: recent})
	_ = c.Write(ctx, websocket.MessageText, histRaw)

	// Aviso de entrada (solo en vivo, tras el historial).
	if d.presenceJoin(roomID, claims.Subject) {
		d.emitNotice(roomID, claims, socialevent.NoticeJoined)
	}

	// Escritor hacia este cliente; termina cuando el handler retorna.
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case <-done:
				return
			case msg := <-send:
				if err := c.Write(ctx, websocket.MessageText, msg); err != nil {
					return
				}
			}
		}
	}()

	limiter := d.ChatLimit
	if limiter == nil {
		limiter = reactions.NewLimiter()
	}

	for {
		_, raw, err := c.Read(ctx)
		if err != nil {
			break
		}
		var in socialevent.ChatSend
		if err := json.Unmarshal(raw, &in); err != nil {
			writeError(ctx, c, "INVALID_PAYLOAD", "")
			continue
		}
		if in.RoomID == "" {
			in.RoomID = roomID
		}
		if err := in.Validate(); err != nil {
			code := "INVALID_PAYLOAD"
			if err == socialevent.ErrTextTooLong {
				code = "TEXT_TOO_LONG"
			}
			writeError(ctx, c, code, in.EventID)
			continue
		}
		if in.RoomID != roomID {
			writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
			continue
		}
		if !limiter.Allow(claims.Subject, d.now()) {
			writeError(ctx, c, "RATE_LIMITED", in.EventID)
			continue
		}
		text := trimText(in.Text)
		received := d.now()
		out := socialevent.ChatMessage{
			EventID: d.newID(), Type: socialevent.TypeChatMessage, RoomID: roomID,
			UserID: claims.Subject, Nick: claims.Nick, Text: text,
			OccurredAt: in.OccurredAt, ReceivedAt: received,
		}
		if err := out.Validate(); err != nil {
			writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
			continue
		}
		length := utf8.RuneCountInString(text)
		_ = d.History.Push(ctx, roomID, out)
		if d.Publish != nil {
			_ = d.Publish(ctx, roomID, out)
		}
		if d.Track != nil {
			d.Track(ctx, roomID, length, out.EventID, out.OccurredAt)
		}
		// broadcastOnce traga el eco de Redis si el relay lo vio primero.
		d.broadcastOnce(roomID, out)
	}

	// Salida explícita antes del defer: el que se va no recibe su propio aviso.
	d.Hub.Leave(roomID, connID)
	if d.presenceLeave(roomID, claims.Subject) {
		d.emitNotice(roomID, claims, socialevent.NoticeLeft)
	}
}

func trimText(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\n' || s[start] == '\r' || s[start] == '\t') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\n' || s[end-1] == '\r' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	hexed := hex.EncodeToString(b[:])
	return hexed[0:8] + "-" + hexed[8:12] + "-" + hexed[12:16] + "-" + hexed[16:20] + "-" + hexed[20:]
}
