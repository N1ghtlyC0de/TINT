package reactions

import (
	"testing"
	"time"
)

func TestLimiterAllowsUpToFivePerSecond(t *testing.T) {
	l := NewLimiter()
	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)

	for i := 0; i < MaxPerSecond; i++ {
		if !l.Allow("u1", base.Add(time.Duration(i)*100*time.Millisecond)) {
			t.Fatalf("reaction %d should be allowed", i+1)
		}
	}
	if l.Allow("u1", base.Add(500*time.Millisecond)) {
		t.Fatal("6th reaction within 1s should be rejected")
	}
	if !l.Allow("u2", base.Add(500*time.Millisecond)) {
		t.Fatal("limits must be per user")
	}
	if !l.Allow("u1", base.Add(1100*time.Millisecond)) {
		t.Fatal("reaction should be allowed once the window slides")
	}
}

func TestBucketIndex(t *testing.T) {
	tests := []struct {
		pos  time.Duration
		want int64
	}{
		{-time.Second, 0},
		{0, 0},
		{4999 * time.Millisecond, 0},
		{5 * time.Second, 1},
		{27 * time.Second, 5},
	}
	for _, tt := range tests {
		if got := BucketIndex(tt.pos); got != tt.want {
			t.Errorf("BucketIndex(%v) = %d, want %d", tt.pos, got, tt.want)
		}
	}
}

// GAM-BE-01: ráfaga masiva sostenida. Con reloj inyectado (sin sleeps):
// 100 intentos en el mismo instante dejan pasar exactamente 5; la ventana
// se desliza y vuelve a dejar pasar; el límite es por usuario.
func TestLimiterMassiveBurst(t *testing.T) {
	l := NewLimiter()
	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)

	allowed := 0
	for i := 0; i < 100; i++ {
		if l.Allow("spammer", base) {
			allowed++
		}
	}
	if allowed != MaxPerSecond {
		t.Fatalf("ráfaga de 100: pasaron %d, want %d", allowed, MaxPerSecond)
	}

	// Otro usuario no se ve afectado por el spam ajeno.
	for i := 0; i < MaxPerSecond; i++ {
		if !l.Allow("vecino", base) {
			t.Fatalf("vecino intento %d rechazado, want permitido", i+1)
		}
	}

	// Ventana deslizada 1s después: el spammer vuelve a tener cuota completa.
	after := base.Add(time.Second + time.Millisecond)
	for i := 0; i < MaxPerSecond; i++ {
		if !l.Allow("spammer", after) {
			t.Fatalf("spammer tras ventana intento %d rechazado, want permitido", i+1)
		}
	}
	if l.Allow("spammer", after) {
		t.Fatal("spammer 6to tras ventana permitido, want rechazado")
	}
}

// Tasa sostenida: 10 intentos/ms durante 3s dejan pasar 5 por ventana (15).
func TestLimiterSustainedRate(t *testing.T) {
	l := NewLimiter()
	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	allowed := 0
	for ms := int64(0); ms < 3000; ms++ {
		for k := 0; k < 10; k++ {
			if l.Allow("u1", base.Add(time.Duration(ms)*time.Millisecond)) {
				allowed++
			}
		}
	}
	if allowed != 3*MaxPerSecond {
		t.Fatalf("tasa sostenida 3s: pasaron %d, want %d", allowed, 3*MaxPerSecond)
	}
}
