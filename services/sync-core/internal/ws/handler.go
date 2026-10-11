// Package ws expone el Canal Sync: GET /ws/sync?room_id=X&token=JWT.
//
// Cada conexión usa dos goroutines:
//   - lectora (la del handler HTTP): lee frames y llama a hub.Handle.
//   - escritora: única dueña de conn.Write; drena la cola del cliente. Los
//     HEARTBEAT los encola el hub con un único temporizador por réplica.
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
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/codec"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/hub"
)

const (
	// MaxMessageBytes limita el tamaño de cada mensaje entrante.
	MaxMessageBytes = 4096
	// StatusRevoked cierra una conexión cuyo token fue revocado: el cliente
	// no debe reconectar con ese token.
	StatusRevoked websocket.StatusCode = 4001
	writeTimeout                       = 5 * time.Second
	checkTimeout                       = 2 * time.Second
)

// Verifier valida el token del handshake.
type Verifier interface {
	Verify(token, roomID string) (auth.Claims, error)
}

// Revocations consulta los tokens revocados por identity-api.
type Revocations interface {
	IsRevoked(ctx context.Context, jti string) (bool, error)
}

// Hub es la parte del hub que usa la capa de transporte.
type Hub interface {
	Connect(ctx context.Context, claims auth.Claims, opts ...hub.ConnOption) (*hub.Client, error)
	Disconnect(c *hub.Client)
	Handle(ctx context.Context, c *hub.Client, raw []byte)
}

// Handler atiende el upgrade a WebSocket del Canal Sync.
type Handler struct {
	hub      Hub
	verifier Verifier
	revoked  Revocations
	origins  []string
}

// NewHandler crea el handler; origins son los patrones de host permitidos.
func NewHandler(h Hub, v Verifier, r Revocations, origins []string) *Handler {
	return &Handler{hub: h, verifier: v, revoked: r, origins: origins}
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
	// Si no se puede comprobar la revocación se rechaza (falla cerrado).
	ctx, cancel := context.WithTimeout(r.Context(), checkTimeout)
	revoked, err := h.revoked.IsRevoked(ctx, claims.JTI)
	cancel()
	switch {
	case err != nil:
		log.Printf("ws: revocación sala %s: %v", roomID, err)
		http.Error(w, "no se pudo validar el token", http.StatusServiceUnavailable)
		return
	case revoked:
		http.Error(w, "token revocado", http.StatusUnauthorized)
		return
	}

	// Subprotocolo opcional: "tint.sync.msgpack" activa frames MessagePack;
	// sin subprotocolo (o "tint.sync.json") se usa JSON.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.origins, Subprotocols: codec.Subprotocols})
	if err != nil {
		return // Accept ya respondió (p. ej. 403 por origen)
	}
	conn.SetReadLimit(MaxMessageBytes)

	client, err := h.hub.Connect(context.WithoutCancel(r.Context()), claims, hub.WithCodec(codec.ForSubprotocol(conn.Subprotocol())))
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
	for {
		select {
		case <-c.Done():
			closeFor(conn, c.Err())
			return
		case msg := <-c.Send():
			if err := write(conn, c.Codec(), msg); err != nil {
				conn.CloseNow()
				return
			}
		}
	}
}

func write(conn *websocket.Conn, cd codec.Codec, msg []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	typ := websocket.MessageText
	if cd.Binary() {
		typ = websocket.MessageBinary
	}
	return conn.Write(ctx, typ, msg)
}

// closeFor traduce la causa de desconexión a un código de cierre WebSocket.
func closeFor(conn *websocket.Conn, cause error) {
	switch {
	case errors.Is(cause, hub.ErrStale):
		_ = conn.Close(websocket.StatusPolicyViolation, "sin respuesta a HEARTBEAT")
	case errors.Is(cause, hub.ErrSlowConsumer):
		_ = conn.Close(websocket.StatusPolicyViolation, "cliente demasiado lento")
	case errors.Is(cause, hub.ErrRevoked):
		_ = conn.Close(StatusRevoked, "token revocado")
	default:
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}
}
