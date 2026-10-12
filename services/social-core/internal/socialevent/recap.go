package socialevent

// Recap de la sala: métricas acumuladas que el cliente pide al terminar.
const (
	TypeRecapRequest Type = "recap_request"
	TypeRecap        Type = "recap"
)

// RecapRequest pide el recap; la respuesta va solo a quien lo pidió.
type RecapRequest struct {
	EventID string `json:"event_id"`
	Type    Type   `json:"type"`
	RoomID  string `json:"room_id"`
}

// Validate verifica un recap_request.
func (m RecapRequest) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeRecapRequest {
		return ErrUnsupportedType
	}
	return nil
}

// TopEmojiUser es quien más reacciones envió en la sala.
type TopEmojiUser struct {
	UserID string `json:"user_id"`
	Nick   string `json:"nick"`
	Count  int64  `json:"count"`
}

// PositionCount es un bucket de 5 s (position_ms = inicio del bucket).
type PositionCount struct {
	PositionMS int64 `json:"position_ms"`
	Count      int64 `json:"count"`
}

// PeakReactions es el bucket con más reacciones y cuántas fueron 😂.
type PeakReactions struct {
	PositionMS int64 `json:"position_ms"`
	Count      int64 `json:"count"`
	Laughs     int64 `json:"laughs"`
}

// RecapTotals son los totales de la sala.
type RecapTotals struct {
	Reactions int64 `json:"reactions"`
	Pauses    int64 `json:"pauses"`
	Rewinds   int64 `json:"rewinds"`
	Polls     int64 `json:"polls"`
}

// Recap es la respuesta a recap_request. Las secciones sin datos van en null.
type Recap struct {
	Type          Type           `json:"type"`
	RoomID        string         `json:"room_id"`
	EventIDRef    string         `json:"event_id_ref,omitempty"`
	TopEmojiUser  *TopEmojiUser  `json:"top_emoji_user"`
	MostPaused    *PositionCount `json:"most_paused"`
	PeakReactions *PeakReactions `json:"peak_reactions"`
	Totals        RecapTotals    `json:"totals"`
}

// SyncEvent es lo que social-core lee de un comando de sync-core publicado
// en room:{id}:sync (solo lectura; el contrato es el del Canal Sync v2).
type SyncEvent struct {
	EventID     string  `json:"event_id"`
	Type        string  `json:"type"`
	PositionMS  int64   `json:"position_ms"`
	Status      string  `json:"status,omitempty"`
	Rate        float64 `json:"rate,omitempty"`
	UpdatedAtMS int64   `json:"updated_at_ms,omitempty"`
	Version     int64   `json:"version"`
}

// Positional indica si el evento es un comando que mueve el ancla de
// reproducción (los únicos que interesan al recap).
func (e SyncEvent) Positional() bool {
	switch e.Type {
	case "PLAY", "PAUSE", "SEEK", "RATE", "LOAD":
		return true
	}
	return false
}
