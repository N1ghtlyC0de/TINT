// Package ws expone el Canal Sync: GET /ws/sync?room_id=X&token=JWT.
//
// Cada conexión usa dos goroutines:
//   - lectora (la del handler HTTP): lee frames y llama a hub.Handle.
//   - escritora: única dueña de conn.Write; drena la cola del cliente y
//     emite un HEARTBEAT por intervalo.
//
// Cuando cualquiera de las dos termina, el contexto del cliente se cancela y
// la otra sale (el cierre del socket desbloquea la lectura y la lectura
// llama a hub.Disconnect, que despierta a la escritora); el handler espera a la escritora antes de retornar, así no
// quedan goroutines huérfanas.
package ws

import (
	"context"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/hub"
)

const (
	// MaxMessageBytes limita el tamaño de cada mensaje entrante.
	MaxMessageBytes = 4096
	writeTimeout    = 5 * time.Second
)

// Verifier valida el token del handshake.
type Verifier interface {
	Verify(token, roomID string) (auth.Claims, error)
}

// Hub es la parte del hub que usa la capa de transporte.
type Hub interface {
	Connect(ctx context.Context, claims auth.Claims) (*hub.Client, error)
	Disconnect(c *hub.Client)
	Handle(ctx context.Context, c *hub.Client, raw []byte)
	Tick(c *hub.Client) ([]byte, error)
	HeartbeatInterval() time.Duration
}

// Handler atiende el upgrade a WebSocket del Canal Sync.
type Handler struct {
	hub      Hub
	verifier Verifier
	origins  []string
}

// NewHandler crea el handler; origins son los patrones de host permitidos.
func NewHandler(h Hub, v Verifier, origins []string) *Handler {
	return &Handler{hub: h, verifier: v, origins: origins}
}

// ServeHTTP valida el token antes del upgrade: un token inválido nunca abre
// el socket. El token viaja en la query (los navegadores no permiten headers
// en WebSocket), por lo que nunca se registra la URL completa.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	roomID, token := q.Get("room_id"), q.Get("token")
	if roomID == "" || token == "" {
		http.Error(w, "room_id y token son obligatorios", http.StatusBadRequest)
		return
	}
	claims, err := h.verifier.Verify(token, roomID)
	switch {
	case errors.Is(err, auth.ErrRoomMismatch):
		http.Error(w, "token de otra sala", http.StatusForbidden)
		return
	case err != nil:
		http.Error(w, "token inválido", http.StatusUnauthorized)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.origins})
	if err != nil {
		return // Accept ya respondió (p. ej. 403 por origen)
	}
	conn.SetReadLimit(MaxMessageBytes)

	client, err := h.hub.Connect(context.WithoutCancel(r.Context()), claims)
	if err != nil {
		log.Printf("ws: connect sala %s: %v", roomID, err)
		_ = conn.Close(websocket.StatusInternalError, "estado de sala no disponible")
		return
	}

	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		h.writeLoop(conn, client)
	}()

	h.readLoop(conn, client)
	h.hub.Disconnect(client)
	<-writerDone
}

// readLoop lee con un contexto que no se cancela: si se cancelara, la
// librería cortaría el socket sin enviar el código de cierre. Es la
// escritora quien cierra el socket con el motivo, y eso termina Read.
func (h *Handler) readLoop(conn *websocket.Conn, c *hub.Client) {
	for {
		_, data, err := conn.Read(context.Background())
		if err != nil {
			return
		}
		h.hub.Handle(c.Context(), c, data)
	}
}

func (h *Handler) writeLoop(conn *websocket.Conn, c *hub.Client) {
	ticker := time.NewTicker(h.hub.HeartbeatInterval())
	defer ticker.Stop()
	for {
		select {
		case <-c.Done():
			closeFor(conn, c.Err())
			return
		case msg := <-c.Send():
			if err := write(conn, msg); err != nil {
				conn.CloseNow()
				return
			}
		case <-ticker.C:
			beat, err := h.hub.Tick(c)
			if err != nil {
				closeFor(conn, err)
				return
			}
			if err := write(conn, beat); err != nil {
				conn.CloseNow()
				return
			}
		}
	}
}

func write(conn *websocket.Conn, msg []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, msg)
}

// closeFor traduce la causa de desconexión a un código de cierre WebSocket.
func closeFor(conn *websocket.Conn, cause error) {
	switch {
	case errors.Is(cause, hub.ErrStale):
		_ = conn.Close(websocket.StatusPolicyViolation, "sin respuesta a HEARTBEAT")
	case errors.Is(cause, hub.ErrSlowConsumer):
		_ = conn.Close(websocket.StatusPolicyViolation, "cliente demasiado lento")
	default:
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}
}
