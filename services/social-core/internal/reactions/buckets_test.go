package reactions

import (
	"testing"
	"time"
)

func TestBucketsCountPerRoomAndWindow(t *testing.T) {
	b := NewBuckets()
	b.Add("r1", 7, "👏")
	b.Add("r1", 7, "👏")
	b.Add("r1", 7, "❤️")
	b.Add("r1", 8, "👏")
	b.Add("r2", 7, "👏")
	if got := b.Count("r1", 7, "👏"); got != 2 {
		t.Fatalf("Count(r1,7,👏) = %d, want 2", got)
	}
	if got := b.Count("r1", 7, "❤️"); got != 1 {
		t.Fatalf("Count(r1,7,❤️) = %d, want 1", got)
	}
	if got := b.Count("r1", 8, "👏"); got != 1 {
		t.Fatalf("Count(r1,8,👏) = %d, want 1", got)
	}
	if got := b.Count("r2", 7, "👏"); got != 1 {
		t.Fatalf("Count(r2,7,👏) = %d, want 1", got)
	}
	if got := b.Count("r1", 7, "😂"); got != 0 {
		t.Fatalf("Count(r1,7,😂) = %d, want 0", got)
	}
	if got := b.Count("nadie", 7, "👏"); got != 0 {
		t.Fatalf("Count(nadie,7,👏) = %d, want 0", got)
	}
}

// Las salas nunca se borraban: memoria sin cota. Una sala sin reacciones
// durante IdleTTL se poda (en el siguiente Add, como mucho una vez por minuto).
func TestBucketsPruneIdleRooms(t *testing.T) {
	clock := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	b := NewBuckets()
	b.Now = func() time.Time { return clock }
	b.Add("vieja", 1, "👏")
	clock = clock.Add(DefaultIdleTTL - time.Minute)
	b.Add("activa", 1, "👏")
	if b.Rooms() != 2 {
		t.Fatalf("salas = %d, want 2", b.Rooms())
	}
	clock = clock.Add(2 * time.Minute) // "vieja" supera IdleTTL; "activa" no
	b.Add("nueva", 1, "👏")
	if b.Rooms() != 2 || b.Count("vieja", 1, "👏") != 0 || b.Count("activa", 1, "👏") != 1 {
		t.Fatalf("tras podar: salas = %d, vieja = %d, activa = %d", b.Rooms(), b.Count("vieja", 1, "👏"), b.Count("activa", 1, "👏"))
	}
}

func TestBucketIndexFiveSeconds(t *testing.T) {
	if got := BucketIndex(0); got != 0 {
		t.Fatalf("BucketIndex(0) = %d, want 0", got)
	}
	if got := BucketIndex(4999 * time.Millisecond); got != 0 {
		t.Fatalf("BucketIndex(4999ms) = %d, want 0", got)
	}
	if got := BucketIndex(5000 * time.Millisecond); got != 1 {
		t.Fatalf("BucketIndex(5000ms) = %d, want 1", got)
	}
	if got := BucketIndex(12345 * time.Millisecond); got != 2 {
		t.Fatalf("BucketIndex(12345ms) = %d, want 2", got)
	}
}
