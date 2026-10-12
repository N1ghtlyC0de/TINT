// Package master modela el Reloj Maestro de una sala (SYNC-BE-02).
//
// El estado no guarda "el segundo actual": guarda un ancla (posición en un
// instante del reloj del servidor) y la posición se calcula bajo demanda.
// Así cada comando es una sola escritura y no hay timers en el servidor.
// El paquete es puro (sin I/O) para poder probarlo de forma determinista.
package master

import (
	"errors"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

// Status es el estado de reproducción de la sala.
type Status string

const (
	Playing Status = "playing"
	Paused  Status = "paused"
)

// DefaultVolume es el volumen de una sala nueva (y de estados persistidos
// antes de existir el campo).
const DefaultVolume = 1.0

// ErrNotCommand indica que el evento no modifica el reloj maestro.
var ErrNotCommand = errors.New("el evento no es un comando de reproducción")

// State es el ancla del Reloj Maestro, persistida en room:{id}:sync_state.
type State struct {
	Status      Status
	PositionMs  int64   // posición del video en el instante UpdatedAtMs
	UpdatedAtMs int64   // reloj del servidor (unix ms) en que se fijó el ancla
	Rate        float64 // velocidad de reproducción
	Version     int64   // orden total de comandos aplicados
	HostID      string
	MediaID     string  // vídeo actual de la sala ("" = sin vídeo)
	Volume      float64 // volumen de la sala en [0, 1] (0 = silencio)
}

// Command es una orden del Host sobre el reproductor.
type Command struct {
	Type       syncevent.Type
	PositionMs int64   // posición del reproductor del Host al emitir el comando
	Rate       float64 // nueva velocidad (RATE)
	MediaID    string  // nuevo vídeo (LOAD)
	Volume     float64 // nuevo volumen (VOLUME)
}

// Initial devuelve una sala nueva: pausada al inicio del video.
func Initial(hostID string, nowMs int64) State {
	return State{Status: Paused, UpdatedAtMs: nowMs, Rate: 1, HostID: hostID, Volume: DefaultVolume}
}

// PositionAt calcula la posición maestra del video en el instante nowMs.
func (s State) PositionAt(nowMs int64) int64 {
	if s.Status != Playing {
		return s.PositionMs
	}
	elapsed := float64(nowMs-s.UpdatedAtMs) * s.rate()
	return max(s.PositionMs+int64(elapsed), 0)
}

// Apply devuelve el nuevo estado tras aplicar cmd. receivedAtMs es el reloj
// del servidor al recibirlo y rttMs el RTT medido del emisor: el Host vio esa
// posición hace ~rtt/2, así que el ancla se fija en ese instante.
// Ante un error devuelve el estado sin cambios.
func (s State) Apply(cmd Command, receivedAtMs, rttMs int64) (State, error) {
	if !(syncevent.Event{Type: cmd.Type}).IsCommand() {
		return s, ErrNotCommand
	}
	if cmd.PositionMs < 0 {
		return s, syncevent.ErrNegativePosition
	}

	switch cmd.Type {
	case syncevent.Volume:
		if err := syncevent.ValidateVolume(cmd.Volume); err != nil {
			return s, err
		}
		next := s.reanchor(receivedAtMs)
		next.Volume = cmd.Volume
		return next, nil
	}

	next := s
	next.Rate = s.rate()
	switch cmd.Type {
	case syncevent.Play:
		next.Status = Playing
	case syncevent.Pause:
		next.Status = Paused
	case syncevent.Rate:
		if err := syncevent.ValidateRate(cmd.Rate); err != nil {
			return s, err
		}
		next.Rate = cmd.Rate
	case syncevent.Load:
		if err := syncevent.ValidateMedia(cmd.MediaID); err != nil {
			return s, err
		}
		next.Status, next.Rate, next.MediaID = Paused, 1, cmd.MediaID
	}
	next.PositionMs = cmd.PositionMs
	next.UpdatedAtMs = receivedAtMs - max(rttMs, 0)/2
	next.Version++
	return next, nil
}

// reanchor fija el ancla en la posición maestra de nowMs sin cambiar el
// status ni la velocidad: para comandos que no mueven la reproducción
// (VOLUME), así la posición es continua y no depende del drift del Host.
func (s State) reanchor(nowMs int64) State {
	next := s
	next.PositionMs = s.PositionAt(nowMs)
	next.UpdatedAtMs = nowMs
	next.Rate = s.rate()
	next.Version++
	return next
}

func (s State) rate() float64 {
	if s.Rate <= 0 {
		return 1
	}
	return s.Rate
}
