package socialevent

import (
	"errors"
	"unicode/utf8"
)

// Encuestas en vivo: el host o cohost crea, todos votan, el estado viaja
// como poll_state.
const (
	TypePollCreate Type = "poll_create"
	TypePollVote   Type = "poll_vote"
	TypePollClose  Type = "poll_close"
	TypePollState  Type = "poll_state"
)

// Límites de producto de una encuesta.
const (
	MaxQuestionRunes = 140
	MaxOptionRunes   = 60
	MinPollOptions   = 2
	MaxPollOptions   = 4
	MinPollSeconds   = 10
	MaxPollSeconds   = 300
)

var (
	ErrInvalidQuestion = errors.New("question debe tener entre 1 y 140 caracteres")
	ErrInvalidOptions  = errors.New("options: 2 a 4 opciones de 1 a 60 caracteres")
	ErrInvalidDuration = errors.New("duration_s debe estar entre 10 y 300")
	ErrMissingPoll     = errors.New("poll_id es obligatorio")
	ErrInvalidOption   = errors.New("option debe ser un índice ≥ 0")
)

// PollCreate es la encuesta que crea el host o cohost.
type PollCreate struct {
	EventID   string   `json:"event_id"`
	Type      Type     `json:"type"`
	RoomID    string   `json:"room_id"`
	Question  string   `json:"question"`
	Options   []string `json:"options"`
	DurationS int      `json:"duration_s"`
}

// Validate verifica un poll_create (con textos recortados).
func (m PollCreate) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypePollCreate {
		return ErrUnsupportedType
	}
	question, options := m.Normalized()
	if !runesBetween(question, 1, MaxQuestionRunes) {
		return ErrInvalidQuestion
	}
	if len(options) < MinPollOptions || len(options) > MaxPollOptions {
		return ErrInvalidOptions
	}
	for _, o := range options {
		if !runesBetween(o, 1, MaxOptionRunes) {
			return ErrInvalidOptions
		}
	}
	if m.DurationS < MinPollSeconds || m.DurationS > MaxPollSeconds {
		return ErrInvalidDuration
	}
	return nil
}

// Normalized devuelve la pregunta y las opciones sin espacios en los bordes.
func (m PollCreate) Normalized() (string, []string) {
	options := make([]string, len(m.Options))
	for i, o := range m.Options {
		options[i] = trim(o)
	}
	return trim(m.Question), options
}

// PollVote es el voto (cambiable) de un usuario: option es el índice.
type PollVote struct {
	EventID string `json:"event_id"`
	Type    Type   `json:"type"`
	RoomID  string `json:"room_id"`
	PollID  string `json:"poll_id"`
	Option  *int   `json:"option"`
}

// Validate verifica un poll_vote (el rango de option lo comprueba Redis).
func (m PollVote) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypePollVote {
		return ErrUnsupportedType
	}
	if m.PollID == "" {
		return ErrMissingPoll
	}
	if m.Option == nil || *m.Option < 0 {
		return ErrInvalidOption
	}
	return nil
}

// PollClose cierra la encuesta antes de tiempo (host o cohost).
type PollClose struct {
	EventID string `json:"event_id"`
	Type    Type   `json:"type"`
	RoomID  string `json:"room_id"`
	PollID  string `json:"poll_id"`
}

// Validate verifica un poll_close.
func (m PollClose) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypePollClose {
		return ErrUnsupportedType
	}
	if m.PollID == "" {
		return ErrMissingPoll
	}
	return nil
}

// PollState es el estado de la encuesta. my_vote solo viaja en mensajes
// dirigidos a un cliente (al entrar y en la respuesta a su propio voto);
// los broadcasts lo omiten y el cliente conserva el último que conoció.
type PollState struct {
	EventID    string   `json:"event_id"`
	Type       Type     `json:"type"`
	RoomID     string   `json:"room_id"`
	PollID     string   `json:"poll_id"`
	Question   string   `json:"question"`
	Options    []string `json:"options"`
	Counts     []int64  `json:"counts"`
	ClosesAtMS int64    `json:"closes_at_ms"`
	Closed     bool     `json:"closed"`
	MyVote     *int     `json:"my_vote,omitempty"`
}

func runesBetween(s string, min, max int) bool {
	n := utf8.RuneCountInString(s)
	return n >= min && n <= max
}
