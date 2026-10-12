package socialevent

import (
	"errors"
	"math"
)

// Puntero láser del host: efímero, sin historial ni persistencia.
const (
	TypeLaserPoint Type = "laser_point"
	TypeLaser      Type = "laser"
)

// ErrInvalidPoint indica coordenadas fuera de [0,1] o no finitas.
var ErrInvalidPoint = errors.New("x e y deben estar en [0,1]")

// LaserPoint es el punto que envía el host o cohost. x e y están
// normalizadas al área del vídeo ([0,1]); end oculta el puntero.
type LaserPoint struct {
	EventID string  `json:"event_id"`
	Type    Type    `json:"type"`
	RoomID  string  `json:"room_id"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	End     bool    `json:"end,omitempty"`
}

// Validate verifica un laser_point.
func (m LaserPoint) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeLaserPoint {
		return ErrUnsupportedType
	}
	if !unit(m.X) || !unit(m.Y) {
		return ErrInvalidPoint
	}
	return nil
}

// Laser es el broadcast del puntero a toda la sala.
type Laser struct {
	EventID string  `json:"event_id"`
	Type    Type    `json:"type"`
	RoomID  string  `json:"room_id"`
	UserID  string  `json:"user_id"`
	Nick    string  `json:"nick"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	End     bool    `json:"end"`
}

// unit indica si v es finito y está en [0,1] (NaN falla ambas comparaciones).
func unit(v float64) bool {
	return v >= 0 && v <= 1 && !math.IsInf(v, 0)
}
