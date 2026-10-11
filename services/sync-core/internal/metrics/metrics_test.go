package metrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestExposition(t *testing.T) {
	r := NewRegistry()
	c := r.Counter("sync_events_total", "Eventos.")
	c.Inc()
	c.Add(2)
	g := r.Gauge("sync_connections", "Conexiones.")
	g.Inc()
	g.Inc()
	g.Dec()
	v := r.CounterVec("sync_commands_total", "Comandos.", "result")
	v.With("ok").Inc()
	v.With("forbidden").Add(3)
	r.GaugeFunc("sync_rooms", "Salas.", func() float64 { return 4 })
	r.CounterFunc("sync_dropped_total", "Descartes.", func() float64 { return 7 })
	h := r.Histogram("sync_apply_seconds", "Latencia.", []float64{0.001, 0.01})
	h.Observe(0.0005)
	h.Observe(0.005)
	h.Observe(1)

	var b strings.Builder
	r.Write(&b)
	want := `# HELP sync_events_total Eventos.
# TYPE sync_events_total counter
sync_events_total 3
# HELP sync_connections Conexiones.
# TYPE sync_connections gauge
sync_connections 1
# HELP sync_commands_total Comandos.
# TYPE sync_commands_total counter
sync_commands_total{result="forbidden"} 3
sync_commands_total{result="ok"} 1
# HELP sync_rooms Salas.
# TYPE sync_rooms gauge
sync_rooms 4
# HELP sync_dropped_total Descartes.
# TYPE sync_dropped_total counter
sync_dropped_total 7
# HELP sync_apply_seconds Latencia.
# TYPE sync_apply_seconds histogram
sync_apply_seconds_bucket{le="0.001"} 1
sync_apply_seconds_bucket{le="0.01"} 2
sync_apply_seconds_bucket{le="+Inf"} 3
sync_apply_seconds_sum 1.0055
sync_apply_seconds_count 3
`
	if got := b.String(); got != want {
		t.Errorf("exposición =\n%s\nwant\n%s", got, want)
	}
}

func TestHandler(t *testing.T) {
	r := NewRegistry()
	r.Counter("x_total", "X.").Inc()
	rec := httptest.NewRecorder()
	r.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != 200 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain; version=0.0.4") || !strings.Contains(rec.Body.String(), "x_total 1") {
		t.Errorf("respuesta = %d %q %q", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
}

func TestConcurrentUpdates(t *testing.T) {
	r := NewRegistry()
	c := r.Counter("c_total", "C.")
	v := r.CounterVec("v_total", "V.", "k")
	h := r.Histogram("h_seconds", "H.", []float64{1})
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				c.Inc()
				v.With("a").Inc()
				h.Observe(0.5)
			}
		}()
	}
	var b strings.Builder
	r.Write(&b) // lectura concurrente con escrituras
	wg.Wait()
	b.Reset()
	r.Write(&b)
	for _, want := range []string{"c_total 5000", `v_total{k="a"} 5000`, "h_seconds_count 5000", "h_seconds_sum 2500"} {
		if !strings.Contains(b.String(), want) {
			t.Errorf("falta %q en\n%s", want, b.String())
		}
	}
}

func TestEscapesLabelValues(t *testing.T) {
	r := NewRegistry()
	r.CounterVec("e_total", "E.", "k").With("a\"b\\c\nd").Inc()
	var b strings.Builder
	r.Write(&b)
	if !strings.Contains(b.String(), `e_total{k="a\"b\\c\nd"} 1`) {
		t.Errorf("escape incorrecto:\n%s", b.String())
	}
}
