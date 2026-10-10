package hub

import (
	"context"
	"errors"
	"sync/atomic"

	"github.com/google/uuid"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/auth"
)

var (
	ErrSlowConsumer = errors.New("cliente demasiado lento: cola de salida llena")
	ErrStale        = errors.New("cliente sin responder SYNC_CHECK")
	ErrClosed       = errors.New("conexión cerrada")
)

// Client es una conexión al Canal Sync. Solo la goroutine escritora lee de
// Send(); el resto del sistema encola sin bloquear.
type Client struct {
	id     string
	claims auth.Claims
	send   chan []byte
	ctx    context.Context
	cancel context.CancelCauseFunc

	rttMs       atomic.Int64 // RTT suavizado (EWMA), medido con el reloj del servidor
	lastCheckMs atomic.Int64 // último SYNC_CHECK recibido
	lastDriftMs atomic.Int64 // último drift medido (se informa en HEARTBEAT)

	// Rate limit por ventana fija; solo lo toca la goroutine lectora.
	windowStartMs int64
	windowCount   int
}

func newClient(parent context.Context, claims auth.Claims, nowMs int64) *Client {
	ctx, cancel := context.WithCancelCause(parent)
	c := &Client{id: uuid.NewString(), claims: claims, send: make(chan []byte, SendBuffer), ctx: ctx, cancel: cancel}
	c.lastCheckMs.Store(nowMs)
	return c
}

// Send es la cola de mensajes salientes del cliente.
func (c *Client) Send() <-chan []byte { return c.send }

// Context se cancela cuando el cliente debe desconectarse.
func (c *Client) Context() context.Context { return c.ctx }

// Done se cierra cuando el cliente debe desconectarse.
func (c *Client) Done() <-chan struct{} { return c.ctx.Done() }

// Err devuelve la causa de la desconexión.
func (c *Client) Err() error { return context.Cause(c.ctx) }

// Claims devuelve la identidad verificada del cliente.
func (c *Client) Claims() auth.Claims { return c.claims }

// RTT devuelve el RTT suavizado en milisegundos.
func (c *Client) RTT() int64 { return c.rttMs.Load() }

// enqueue nunca bloquea: un cliente lento no puede frenar a los demás.
func (c *Client) enqueue(msg []byte) {
	if c.ctx.Err() != nil {
		return
	}
	select {
	case c.send <- msg:
	default:
		c.close(ErrSlowConsumer)
	}
}

func (c *Client) close(cause error) { c.cancel(cause) }

func (c *Client) allow(nowMs int64) bool {
	if nowMs-c.windowStartMs >= 1000 {
		c.windowStartMs, c.windowCount = nowMs, 0
	}
	c.windowCount++
	return c.windowCount <= MaxMsgsPerSecond
}
