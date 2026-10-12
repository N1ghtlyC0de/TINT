package socialevent

import (
	"math"
	"testing"
)

func TestLaserPointValidate(t *testing.T) {
	ok := LaserPoint{EventID: "e1", Type: TypeLaserPoint, RoomID: "r1", X: 0.5, Y: 1}
	if err := ok.Validate(); err != nil {
		t.Fatalf("Validate() = %v, want nil", err)
	}
	edge := LaserPoint{EventID: "e1", Type: TypeLaserPoint, X: 0, Y: 0, End: true}
	if err := edge.Validate(); err != nil {
		t.Fatalf("bordes 0,0 = %v, want nil", err)
	}
	cases := map[string]LaserPoint{
		"sin event_id": {Type: TypeLaserPoint, X: 0.1, Y: 0.1},
		"tipo":         {EventID: "e", Type: TypeChatSend, X: 0.1, Y: 0.1},
		"x negativa":   {EventID: "e", Type: TypeLaserPoint, X: -0.01, Y: 0.1},
		"y > 1":        {EventID: "e", Type: TypeLaserPoint, X: 0.1, Y: 1.01},
		"x NaN":        {EventID: "e", Type: TypeLaserPoint, X: math.NaN(), Y: 0.1},
		"y Inf":        {EventID: "e", Type: TypeLaserPoint, X: 0.1, Y: math.Inf(1)},
	}
	for name, m := range cases {
		if err := m.Validate(); err == nil {
			t.Errorf("%s: Validate() = nil, want error", name)
		}
	}
}
