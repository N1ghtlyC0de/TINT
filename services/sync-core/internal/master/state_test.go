package master

import (
	"errors"
	"testing"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

const t0 = int64(1_791_655_200_000) // instante fijo del reloj del servidor (unix ms)

func TestInitial(t *testing.T) {
	s := Initial("host-1", t0)
	if s.Status != Paused || s.PositionMs != 0 || s.UpdatedAtMs != t0 || s.Rate != 1 || s.Version != 0 || s.HostID != "host-1" {
		t.Fatalf("estado inicial inesperado: %+v", s)
	}
}

func TestPositionAt(t *testing.T) {
	tests := []struct {
		name  string
		state State
		now   int64
		want  int64
	}{
		{"paused ignora el tiempo", State{Status: Paused, PositionMs: 5000, UpdatedAtMs: t0, Rate: 1}, t0 + 10_000, 5000},
		{"playing avanza con el reloj", State{Status: Playing, PositionMs: 5000, UpdatedAtMs: t0, Rate: 1}, t0 + 2_500, 7500},
		{"playing en el mismo instante del ancla", State{Status: Playing, PositionMs: 5000, UpdatedAtMs: t0, Rate: 1}, t0, 5000},
		{"rate 1.5", State{Status: Playing, PositionMs: 0, UpdatedAtMs: t0, Rate: 1.5}, t0 + 2_000, 3000},
		{"rate cero se trata como 1", State{Status: Playing, PositionMs: 0, UpdatedAtMs: t0}, t0 + 1_000, 1000},
		{"instante previo al ancla retrocede", State{Status: Playing, PositionMs: 5000, UpdatedAtMs: t0, Rate: 1}, t0 - 1_000, 4000},
		{"nunca negativo", State{Status: Playing, PositionMs: 100, UpdatedAtMs: t0, Rate: 1}, t0 - 1_000, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.state.PositionAt(tt.now); got != tt.want {
				t.Errorf("PositionAt = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestApply(t *testing.T) {
	paused := State{Status: Paused, PositionMs: 1000, UpdatedAtMs: t0, Rate: 1, Version: 7, HostID: "host-1"}
	playing := State{Status: Playing, PositionMs: 1000, UpdatedAtMs: t0, Rate: 1, Version: 7, HostID: "host-1"}
	recv := t0 + 3_000

	tests := []struct {
		name    string
		from    State
		cmd     Command
		rtt     int64
		want    State
		wantErr error
	}{
		{
			name: "play fija el ancla compensando medio RTT",
			from: paused, cmd: Command{Type: syncevent.Play, PositionMs: 1000}, rtt: 80,
			want: State{Status: Playing, PositionMs: 1000, UpdatedAtMs: recv - 40, Rate: 1, Version: 8, HostID: "host-1"},
		},
		{
			name: "pause congela el fotograma del host",
			from: playing, cmd: Command{Type: syncevent.Pause, PositionMs: 4000}, rtt: 80,
			want: State{Status: Paused, PositionMs: 4000, UpdatedAtMs: recv - 40, Rate: 1, Version: 8, HostID: "host-1"},
		},
		{
			name: "seek mientras reproduce conserva playing",
			from: playing, cmd: Command{Type: syncevent.Seek, PositionMs: 60_000}, rtt: 0,
			want: State{Status: Playing, PositionMs: 60_000, UpdatedAtMs: recv, Rate: 1, Version: 8, HostID: "host-1"},
		},
		{
			name: "seek en pausa conserva paused",
			from: paused, cmd: Command{Type: syncevent.Seek, PositionMs: 30_000}, rtt: 0,
			want: State{Status: Paused, PositionMs: 30_000, UpdatedAtMs: recv, Rate: 1, Version: 8, HostID: "host-1"},
		},
		{
			name: "rtt negativo se ignora",
			from: paused, cmd: Command{Type: syncevent.Play, PositionMs: 1000}, rtt: -50,
			want: State{Status: Playing, PositionMs: 1000, UpdatedAtMs: recv, Rate: 1, Version: 8, HostID: "host-1"},
		},
		{
			name: "rate cero se normaliza a 1",
			from: State{Status: Paused, Version: 1}, cmd: Command{Type: syncevent.Play, PositionMs: 0}, rtt: 0,
			want: State{Status: Playing, PositionMs: 0, UpdatedAtMs: recv, Rate: 1, Version: 2},
		},
		{
			name: "posicion negativa rechazada",
			from: paused, cmd: Command{Type: syncevent.Seek, PositionMs: -1},
			want: paused, wantErr: syncevent.ErrNegativePosition,
		},
		{
			name: "heartbeat no es un comando",
			from: paused, cmd: Command{Type: syncevent.Heartbeat},
			want: paused, wantErr: ErrNotCommand,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := tt.from.Apply(tt.cmd, recv, tt.rtt)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("Apply =\n %+v\nwant\n %+v", got, tt.want)
			}
		})
	}
}

func TestApplyVersionIsMonotonic(t *testing.T) {
	s := Initial("host-1", t0)
	cmds := []Command{
		{Type: syncevent.Play, PositionMs: 0},
		{Type: syncevent.Seek, PositionMs: 10_000},
		{Type: syncevent.Pause, PositionMs: 12_000},
	}
	for i, c := range cmds {
		var err error
		s, err = s.Apply(c, t0+int64(i)*1000, 0)
		if err != nil {
			t.Fatal(err)
		}
		if s.Version != int64(i+1) {
			t.Fatalf("version tras %d comandos = %d", i+1, s.Version)
		}
	}
	if s.PositionAt(t0+99_000) != 12_000 {
		t.Errorf("tras PAUSE la posición debe quedar fija en 12000, got %d", s.PositionAt(t0+99_000))
	}
}

func TestApplyV2(t *testing.T) {
	playing := State{Status: Playing, PositionMs: 1000, UpdatedAtMs: t0, Rate: 1, Version: 3, HostID: "h", MediaID: "m1"}
	paused := playing
	paused.Status = Paused
	recv := t0 + 2_000

	tests := []struct {
		name    string
		from    State
		cmd     Command
		want    State
		wantErr error
	}{
		{
			name: "rate re-ancla y conserva playing y media",
			from: playing, cmd: Command{Type: syncevent.Rate, PositionMs: 3000, Rate: 1.5},
			want: State{Status: Playing, PositionMs: 3000, UpdatedAtMs: recv, Rate: 1.5, Version: 4, HostID: "h", MediaID: "m1"},
		},
		{
			name: "rate en pausa conserva paused",
			from: paused, cmd: Command{Type: syncevent.Rate, PositionMs: 1000, Rate: 0.5},
			want: State{Status: Paused, PositionMs: 1000, UpdatedAtMs: recv, Rate: 0.5, Version: 4, HostID: "h", MediaID: "m1"},
		},
		{
			name: "rate fuera de rango",
			from: playing, cmd: Command{Type: syncevent.Rate, PositionMs: 1000, Rate: 9},
			want: playing, wantErr: syncevent.ErrInvalidRate,
		},
		{
			name: "load pausa, reinicia rate y cambia media",
			from: State{Status: Playing, PositionMs: 9000, UpdatedAtMs: t0, Rate: 2, Version: 3, HostID: "h", MediaID: "m1"},
			cmd:  Command{Type: syncevent.Load, PositionMs: 0, MediaID: "m2"},
			want: State{Status: Paused, PositionMs: 0, UpdatedAtMs: recv, Rate: 1, Version: 4, HostID: "h", MediaID: "m2"},
		},
		{
			name: "load sin media",
			from: playing, cmd: Command{Type: syncevent.Load},
			want: playing, wantErr: syncevent.ErrInvalidMedia,
		},
		{
			name: "seek conserva la media y la velocidad",
			from: State{Status: Playing, PositionMs: 0, UpdatedAtMs: t0, Rate: 1.25, Version: 3, MediaID: "m1"},
			cmd:  Command{Type: syncevent.Seek, PositionMs: 5000},
			want: State{Status: Playing, PositionMs: 5000, UpdatedAtMs: recv, Rate: 1.25, Version: 4, MediaID: "m1"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := tt.from.Apply(tt.cmd, recv, 0)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("Apply =\n %+v\nwant\n %+v", got, tt.want)
			}
		})
	}
}

func TestInitialVolume(t *testing.T) {
	if s := Initial("h", t0); s.Volume != 1 {
		t.Errorf("volumen inicial = %v, want 1", s.Volume)
	}
}

func TestApplyVolume(t *testing.T) {
	recv := t0 + 2_000
	playing := State{Status: Playing, PositionMs: 1000, UpdatedAtMs: t0, Rate: 1.5, Version: 3, HostID: "h", MediaID: "m1", Volume: 1}

	// Reproduciendo: conserva status, velocidad y media; re-ancla en la
	// posición maestra de la recepción (sin saltos) e incrementa version.
	got, err := playing.Apply(Command{Type: syncevent.Volume, PositionMs: 99_999, Volume: 0.25}, recv, 400)
	if err != nil {
		t.Fatal(err)
	}
	want := State{Status: Playing, PositionMs: 4000, UpdatedAtMs: recv, Rate: 1.5, Version: 4, HostID: "h", MediaID: "m1", Volume: 0.25}
	if got != want {
		t.Errorf("Apply VOLUME =\n %+v\nwant\n %+v", got, want)
	}
	for _, at := range []int64{recv, recv + 1_000} {
		if got.PositionAt(at) != playing.PositionAt(at) {
			t.Errorf("VOLUME alteró la posición en %d: %d vs %d", at, got.PositionAt(at), playing.PositionAt(at))
		}
	}

	// En pausa y silencio (0) también es válido.
	paused := playing
	paused.Status = Paused
	got, err = paused.Apply(Command{Type: syncevent.Volume, Volume: 0}, recv, 0)
	if err != nil || got.Status != Paused || got.PositionMs != 1000 || got.Volume != 0 || got.Version != 4 {
		t.Errorf("VOLUME en pausa = %+v (%v)", got, err)
	}

	// Fuera de rango: estado intacto.
	got, err = playing.Apply(Command{Type: syncevent.Volume, Volume: 1.5}, recv, 0)
	if !errors.Is(err, syncevent.ErrInvalidVolume) || got != playing {
		t.Errorf("VOLUME fuera de rango = %+v (%v)", got, err)
	}

	// Los demás comandos conservan el volumen.
	got, _ = playing.Apply(Command{Type: syncevent.Load, MediaID: "m2"}, recv, 0)
	if got.Volume != 1 {
		t.Errorf("LOAD cambió el volumen: %+v", got)
	}
}
