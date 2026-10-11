// Package metrics expone métricas en el formato de texto de Prometheus
// (versión 0.0.4) sin dependencias externas: contadores, gauges,
// contadores con una etiqueta e histogramas de buckets fijos.
//
// Todas las operaciones son seguras para concurrencia y no asignan memoria
// en el camino caliente (Inc/Add/Observe usan atomics).
package metrics

import (
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// Registry agrupa las métricas en orden de registro.
type Registry struct {
	mu      sync.Mutex
	entries []entry
}

type entry struct {
	name, help, kind string
	write            func(w io.Writer, name string)
}

// NewRegistry crea un registro vacío.
func NewRegistry() *Registry { return &Registry{} }

func (r *Registry) add(name, help, kind string, write func(io.Writer, string)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries = append(r.entries, entry{name: name, help: help, kind: kind, write: write})
}

// Counter es un contador monotónico.
type Counter struct{ v atomic.Int64 }

func (c *Counter) Inc()        { c.v.Add(1) }
func (c *Counter) Add(n int64) { c.v.Add(n) }

// Gauge es un valor que sube y baja.
type Gauge struct{ v atomic.Int64 }

func (g *Gauge) Inc() { g.v.Add(1) }
func (g *Gauge) Dec() { g.v.Add(-1) }

// Counter registra un contador.
func (r *Registry) Counter(name, help string) *Counter {
	c := &Counter{}
	r.add(name, help, "counter", func(w io.Writer, n string) { sample(w, n, "", float64(c.v.Load())) })
	return c
}

// Gauge registra un gauge.
func (r *Registry) Gauge(name, help string) *Gauge {
	g := &Gauge{}
	r.add(name, help, "gauge", func(w io.Writer, n string) { sample(w, n, "", float64(g.v.Load())) })
	return g
}

// CounterFunc registra un contador cuyo valor se lee al exponer.
func (r *Registry) CounterFunc(name, help string, fn func() float64) {
	r.add(name, help, "counter", func(w io.Writer, n string) { sample(w, n, "", fn()) })
}

// GaugeFunc registra un gauge cuyo valor se lee al exponer.
func (r *Registry) GaugeFunc(name, help string, fn func() float64) {
	r.add(name, help, "gauge", func(w io.Writer, n string) { sample(w, n, "", fn()) })
}

// CounterVec es un contador con una etiqueta.
type CounterVec struct {
	label    string
	children sync.Map // valor de la etiqueta → *Counter
}

// With devuelve el contador para un valor de la etiqueta.
func (v *CounterVec) With(value string) *Counter {
	if c, ok := v.children.Load(value); ok {
		return c.(*Counter)
	}
	c, _ := v.children.LoadOrStore(value, &Counter{})
	return c.(*Counter)
}

// CounterVec registra un contador con una etiqueta.
func (r *Registry) CounterVec(name, help, label string) *CounterVec {
	v := &CounterVec{label: label}
	r.add(name, help, "counter", func(w io.Writer, n string) {
		var values []string
		v.children.Range(func(k, _ any) bool { values = append(values, k.(string)); return true })
		slices.Sort(values)
		for _, val := range values {
			sample(w, n, fmt.Sprintf(`{%s="%s"}`, v.label, escape(val)), float64(v.With(val).v.Load()))
		}
	})
	return v
}

// Histogram cuenta observaciones en buckets acumulativos.
type Histogram struct {
	bounds  []float64
	counts  []atomic.Uint64 // uno por bucket + Inf
	sumBits atomic.Uint64   // float64 en bits, actualizado con CAS
}

// Observe registra un valor.
func (h *Histogram) Observe(v float64) {
	i, _ := slices.BinarySearch(h.bounds, v)
	h.counts[i].Add(1)
	for {
		old := h.sumBits.Load()
		if h.sumBits.CompareAndSwap(old, math.Float64bits(math.Float64frombits(old)+v)) {
			return
		}
	}
}

// Histogram registra un histograma; buckets en orden ascendente.
func (r *Registry) Histogram(name, help string, buckets []float64) *Histogram {
	h := &Histogram{bounds: buckets, counts: make([]atomic.Uint64, len(buckets)+1)}
	r.add(name, help, "histogram", func(w io.Writer, n string) {
		var cum uint64
		for i, b := range h.bounds {
			cum += h.counts[i].Load()
			sample(w, n+"_bucket", `{le="`+format(b)+`"}`, float64(cum))
		}
		cum += h.counts[len(h.bounds)].Load()
		sample(w, n+"_bucket", `{le="+Inf"}`, float64(cum))
		sample(w, n+"_sum", "", math.Float64frombits(h.sumBits.Load()))
		sample(w, n+"_count", "", float64(cum))
	})
	return h
}

// Write escribe todas las métricas en formato de texto de Prometheus.
func (r *Registry) Write(w io.Writer) {
	r.mu.Lock()
	entries := slices.Clone(r.entries)
	r.mu.Unlock()
	for _, e := range entries {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", e.name, e.help, e.name, e.kind)
		e.write(w, e.name)
	}
}

// Handler sirve las métricas (GET /metrics).
func (r *Registry) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		r.Write(w)
	})
}

func sample(w io.Writer, name, labels string, v float64) {
	fmt.Fprintf(w, "%s%s %s\n", name, labels, format(v))
}

func format(v float64) string {
	return strconv.FormatFloat(v, 'g', -1, 64)
}

var labelEscaper = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)

func escape(v string) string { return labelEscaper.Replace(v) }
