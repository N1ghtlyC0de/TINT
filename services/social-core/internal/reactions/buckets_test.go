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
