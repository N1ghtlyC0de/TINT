package socialevent

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRecapRequestValidate(t *testing.T) {
	if err := (RecapRequest{EventID: "e", Type: TypeRecapRequest}).Validate(); err != nil {
		t.Fatalf("Validate() = %v", err)
	}
	if err := (RecapRequest{Type: TypeRecapRequest}).Validate(); err == nil {
		t.Fatal("sin event_id debe fallar")
	}
	if err := (RecapRequest{EventID: "e", Type: TypeChatSend}).Validate(); err == nil {
		t.Fatal("tipo incorrecto debe fallar")
	}
}

// Las secciones sin datos viajan como null (no se omiten).
func TestRecapNullSections(t *testing.T) {
	raw, err := json.Marshal(Recap{Type: TypeRecap, RoomID: "r1"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"top_emoji_user":null`, `"most_paused":null`, `"peak_reactions":null`, `"totals":{"reactions":0,"pauses":0,"rewinds":0,"polls":0}`} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("recap = %s, want %s", raw, want)
		}
	}
}

func TestSyncEventCountable(t *testing.T) {
	for typ, want := range map[string]bool{"PLAY": true, "PAUSE": true, "SEEK": true, "RATE": true, "LOAD": true, "HEARTBEAT": false, "REVOKED": false, "STATE": false} {
		if got := (SyncEvent{Type: typ}).Positional(); got != want {
			t.Errorf("Positional(%s) = %v, want %v", typ, got, want)
		}
	}
}
