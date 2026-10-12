package socialevent

import (
	"strings"
	"testing"
)

func TestChatSlowModeValidate(t *testing.T) {
	sec := func(n int) *int { return &n }
	cases := []struct {
		name string
		m    ChatSlowMode
		want error
	}{
		{"apagado", ChatSlowMode{EventID: "e", Type: TypeChatSlowMode, Seconds: sec(0)}, nil},
		{"60", ChatSlowMode{EventID: "e", Type: TypeChatSlowMode, Seconds: sec(60)}, nil},
		{"sin event", ChatSlowMode{Type: TypeChatSlowMode, Seconds: sec(5)}, ErrMissingEventID},
		{"tipo malo", ChatSlowMode{EventID: "e", Type: "x", Seconds: sec(5)}, ErrUnsupportedType},
		{"sin seconds", ChatSlowMode{EventID: "e", Type: TypeChatSlowMode}, ErrInvalidSlowMode},
		{"fuera del set", ChatSlowMode{EventID: "e", Type: TypeChatSlowMode, Seconds: sec(15)}, ErrInvalidSlowMode},
	}
	for _, c := range cases {
		if err := c.m.Validate(); err != c.want {
			t.Errorf("%s: %v, want %v", c.name, err, c.want)
		}
	}
}

func TestChatMuteValidate(t *testing.T) {
	yes := true
	cases := []struct {
		name string
		m    ChatMute
		want error
	}{
		{"ok", ChatMute{EventID: "e", Type: TypeChatMute, UserID: "guest:a", Muted: &yes}, nil},
		{"sin event", ChatMute{Type: TypeChatMute, UserID: "guest:a", Muted: &yes}, ErrMissingEventID},
		{"tipo malo", ChatMute{EventID: "e", Type: "x", UserID: "guest:a", Muted: &yes}, ErrUnsupportedType},
		{"sin user", ChatMute{EventID: "e", Type: TypeChatMute, UserID: "  ", Muted: &yes}, ErrMissingUser},
		{"user largo", ChatMute{EventID: "e", Type: TypeChatMute, UserID: strings.Repeat("u", MaxUserIDRunes+1), Muted: &yes}, ErrMissingUser},
		{"sin muted", ChatMute{EventID: "e", Type: TypeChatMute, UserID: "guest:a"}, ErrMissingMuted},
	}
	for _, c := range cases {
		if err := c.m.Validate(); err != c.want {
			t.Errorf("%s: %v, want %v", c.name, err, c.want)
		}
	}
}
