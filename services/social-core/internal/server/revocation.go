// Package server — revocación de tokens de invitado (contrato con identity-api).
//
// identity-api revoca con SET token:revoked:{jti} (EXAT exp) y PUBLISH
// {"type":"REVOKED","jti":…} en room:{id}:sync. social-core comprueba la
// clave en el handshake y, por la suscripción de sala del relay, cierra con
// 4001 los sockets vivos de ese jti (borrar una sala revoca todos sus jti).
package server

import (
	"context"
	"time"

	"nhooyr.io/websocket"
)

// StatusRevoked cierra una conexión cuyo token fue revocado (igual que sync-core).
const StatusRevoked websocket.StatusCode = 4001

// revocationTimeout acota el EXISTS del handshake.
const revocationTimeout = 2 * time.Second

// liveConn es una conexión local revocable.
type liveConn struct {
	jti   string
	close func()
}

// checkRevoked consulta token:revoked:{jti}. Sin fuente de revocación
// (modo memoria, sin Redis) no hay nada que consultar.
func (d *Deps) checkRevoked(ctx context.Context, jti string) (bool, error) {
	if d.IsRevoked == nil || jti == "" {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(ctx, revocationTimeout)
	defer cancel()
	return d.IsRevoked(ctx, jti)
}

// trackConn registra una conexión para poder revocarla; devuelve el untrack.
func (d *Deps) trackConn(roomID, connID, jti string, closeFn func()) func() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.conns == nil {
		d.conns = make(map[string]map[string]liveConn)
	}
	room := d.conns[roomID]
	if room == nil {
		room = make(map[string]liveConn)
		d.conns[roomID] = room
	}
	room[connID] = liveConn{jti: jti, close: closeFn}
	return func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		delete(d.conns[roomID], connID)
		if len(d.conns[roomID]) == 0 {
			delete(d.conns, roomID)
		}
	}
}

// revokeLocal cierra las conexiones locales de la sala con ese jti.
func (d *Deps) revokeLocal(roomID, jti string) {
	if jti == "" {
		return
	}
	d.mu.Lock()
	var victims []func()
	for _, c := range d.conns[roomID] {
		if c.jti == jti {
			victims = append(victims, c.close)
		}
	}
	d.mu.Unlock()
	for _, closeFn := range victims {
		closeFn()
	}
}
