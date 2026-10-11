// Package server — detección de conexiones muertas en /ws/social.
package server

import (
	"context"
	"time"

	"nhooyr.io/websocket"
)

const (
	// DefaultPingInterval es la cadencia del ping de servidor.
	DefaultPingInterval = 20 * time.Second
	// DefaultPingTimeout es cuánto se espera el pong antes de cerrar.
	DefaultPingTimeout = 10 * time.Second
	// DefaultWriteTimeout acota cada escritura: un cliente que no lee no bloquea.
	DefaultWriteTimeout = 5 * time.Second
)

func (d *Deps) pingInterval() time.Duration {
	if d.PingInterval > 0 {
		return d.PingInterval
	}
	return DefaultPingInterval
}

func (d *Deps) writeTimeout() time.Duration {
	if d.WriteTimeout > 0 {
		return d.WriteTimeout
	}
	return DefaultWriteTimeout
}

func (d *Deps) pingTimeout() time.Duration {
	if d.PingTimeout > 0 {
		return d.PingTimeout
	}
	return DefaultPingTimeout
}

// writeMsg escribe con plazo: un cliente que no lee no bloquea al servidor.
func writeMsg(ctx context.Context, c *websocket.Conn, msg []byte, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return c.Write(ctx, websocket.MessageText, msg)
}

// keepAlive hace ping periódico; si el pong no llega a tiempo, corta el
// socket para que el handler termine y la presencia emita "salió".
// Termina cuando se cierra done (el handler retornó).
func (d *Deps) keepAlive(c *websocket.Conn, done <-chan struct{}) {
	ticker := time.NewTicker(d.pingInterval())
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), d.pingTimeout())
			err := c.Ping(ctx)
			cancel()
			if err != nil {
				c.CloseNow()
				return
			}
		}
	}
}
