// Package server — endpoint WebSocket del Canal Social (/ws/social, solo chat).
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
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
	// HostKeys resuelve las claves públicas de Firebase por kid. Nil o sin
	// FirebaseProjectID = los host tokens se rechazan (falla cerrado).
	HostKeys auth.KeySource
	// Utilidades
	Now       func() time.Time
	NewID     func() string
	ChatLimit *reactions.Limiter
	// ReactionLimit frena el spam de reacciones (5/s por conexión, en memoria).
	// Nil = limitador propio por conexión (igual que el chat).
	ReactionLimit *reactions.Limiter
	// ReactionBuckets acumula conteos por sala y ventana de 5s (base del
	// heatmap). Nil = no se agregan (solo broadcast en vivo).
	ReactionBuckets *reactions.Buckets
	// Estado interno del relay compartido y dedup (ver relay.go).
	mu     sync.Mutex
	relays map[string]*roomRelay
	seen   *seenIDs
	// LeaveGrace retrasa el aviso de salida: si el usuario vuelve dentro de
	// la ventana se considera el mismo de antes (cero = DefaultLeaveGrace).
	LeaveGrace time.Duration
	// presence cuenta conexiones por sala y usuario para no spamear avisos
	// con multipestaña, StrictMode (doble montaje) o flaps de red.
	presence map[string]map[string]*presenceEntry
}

// DefaultLeaveGrace es la ventana de gracia de presencia en producción.
const DefaultLeaveGrace = 5 * time.Second

// presenceEntry lleva las conexiones activas, la última salida y una
// generación para invalidar timers viejos cuando el usuario reingresa.
type presenceEntry struct {
	conns     int
	lastLeave time.Time
	gen       uint64
}

func (d *Deps) leaveGrace() time.Duration {
	if d.LeaveGrace > 0 {
		return d.LeaveGrace
	}
	return DefaultLeaveGrace
}

func (d *Deps) presenceUsers(roomID string) map[string]*presenceEntry {
	if d.presence == nil {
		d.presence = make(map[string]map[string]*presenceEntry)
	}
	users := d.presence[roomID]
	if users == nil {
		users = make(map[string]*presenceEntry)
		d.presence[roomID] = users
	}
	return users
}

// presenceJoin suma una conexión; true si hay que avisar la entrada.
// No se avisa si ya hay otra conexión activa (multipestaña) ni si el
// usuario salió dentro de la ventana de gracia (reingreso/flap).
func (d *Deps) presenceJoin(roomID, userID string, now time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	users := d.presenceUsers(roomID)
	e := users[userID]
	if e == nil {
		e = &presenceEntry{}
		users[userID] = e
	}
	e.conns++
	e.gen++
	if e.conns > 1 {
		return false
	}
	if !e.lastLeave.IsZero() && now.Sub(e.lastLeave) < d.leaveGrace() {
		return false
	}
	return true
}

// presenceLeave resta una conexión y, si fue la última, programa el aviso
// de salida tras la gracia: solo se emite si el usuario sigue ausente
// (misma generación). Así un reingreso rápido cancela el aviso.
func (d *Deps) presenceLeave(roomID string, claims auth.Claims) {
	d.mu.Lock()
	users := d.presence[roomID]
	e := users[claims.Subject]
	if e == nil || e.conns <= 0 {
		d.mu.Unlock()
		return
	}
	e.conns--
	if e.conns > 0 {
		d.mu.Unlock()
		return
	}
	e.lastLeave = d.now()
	e.gen++
	gen := e.gen
	grace := d.leaveGrace()
	d.mu.Unlock()
	time.AfterFunc(grace, func() {
		d.mu.Lock()
		cur := d.presence[roomID][claims.Subject]
		fire := cur != nil && cur.conns == 0 && cur.gen == gen
		d.mu.Unlock()
		if fire {
			d.emitNotice(roomID, claims, socialevent.NoticeLeft)
		}
	})
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

// authenticate elige el verificador por el alg del header: HS256 = guest
// token de identity-api; RS256 = Firebase ID token del host. Un token HS256
// inválido nunca cae al camino de host, y nada se acepta sin firma válida.
func (d *Deps) authenticate(ctx context.Context, token, roomID string) (auth.Claims, error) {
	now := d.now()
	switch auth.TokenAlg(token) {
	case "HS256":
		return auth.VerifyGuest(token, d.JWTSecret, roomID, now)
	case "RS256":
		return auth.VerifyHost(ctx, token, d.FirebaseProjectID, d.HostKeys, now)
	default:
		return auth.Claims{}, auth.ErrInvalidToken
	}
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
	claims, err := d.authenticate(ctx, token, roomID)
	if err != nil {
		status := http.StatusUnauthorized
		if errors.Is(err, auth.ErrWrongRoom) {
			status = http.StatusForbidden
		}
		http.Error(w, http.StatusText(status), status)
		return
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

	// Aviso de entrada (solo en vivo, tras el historial). Se perdona el
	// reingreso dentro de la gracia (StrictMode, refresh, flap).
	if d.presenceJoin(roomID, claims.Subject, d.now()) {
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
	reactLimiter := d.ReactionLimit
	if reactLimiter == nil {
		reactLimiter = reactions.NewLimiter()
	}

	for {
		_, raw, err := c.Read(ctx)
		if err != nil {
			break
		}
		var envelope struct {
			Type socialevent.Type `json:"type"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			writeError(ctx, c, "INVALID_PAYLOAD", "")
			continue
		}
		if envelope.Type == socialevent.TypeReactionSend {
			d.handleReaction(ctx, c, roomID, claims, raw, reactLimiter)
			continue
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
			OccurredAt: socialevent.ClampOccurred(in.OccurredAt, received), ReceivedAt: received,
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
	// El aviso de salida es diferido (ventana de gracia): si el usuario
	// vuelve antes, se cancela.
	d.Hub.Leave(roomID, connID)
	d.presenceLeave(roomID, claims)
}

// handleReaction valida, limita (5/s en memoria), agrega al bucket de 5s y
// emite la reacción en vivo. Efímera: sin historial ni analítica.
func (d *Deps) handleReaction(ctx context.Context, c *websocket.Conn, roomID string, claims auth.Claims, raw []byte, limiter *reactions.Limiter) {
	var in socialevent.ReactionSend
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", "")
		return
	}
	if in.RoomID == "" {
		in.RoomID = roomID
	}
	if err := in.Validate(); err != nil {
		code := "INVALID_PAYLOAD"
		if err == socialevent.ErrInvalidEmoji {
			code = "INVALID_EMOJI"
		}
		writeError(ctx, c, code, in.EventID)
		return
	}
	if in.RoomID != roomID {
		writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
		return
	}
	if !limiter.Allow(claims.Subject, d.now()) {
		writeError(ctx, c, "RATE_LIMITED", in.EventID)
		return
	}
	received := d.now()
	out := socialevent.Reaction{
		EventID: d.newID(), Type: socialevent.TypeReaction, RoomID: roomID,
		UserID: claims.Subject, Nick: claims.Nick, Emoji: socialevent.TrimmedEmoji(in.Emoji),
		PositionMS: in.PositionMS, OccurredAt: socialevent.ClampOccurred(in.OccurredAt, received), ReceivedAt: received,
	}
	if err := out.Validate(); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
		return
	}
	if d.ReactionBuckets != nil {
		d.ReactionBuckets.Add(roomID, reactions.BucketIndex(bucketPosition(out.PositionMS)), out.Emoji)
	}
	d.broadcastRawOnce(roomID, out.EventID, out)
}

func bucketPosition(ms int64) time.Duration {
	if ms < 0 {
		return 0
	}
	return time.Duration(ms) * time.Millisecond
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
