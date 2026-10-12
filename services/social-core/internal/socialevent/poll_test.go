package socialevent

import (
	"strings"
	"testing"
)

func basePoll() PollCreate {
	return PollCreate{
		EventID: "p1", Type: TypePollCreate, RoomID: "r1",
		Question: "¿Seguimos?", Options: []string{"Sí", "No"}, DurationS: 30,
	}
}

func TestPollCreateValidate(t *testing.T) {
	if err := basePoll().Validate(); err != nil {
		t.Fatalf("Validate() = %v, want nil", err)
	}
	max := basePoll()
	max.Question = strings.Repeat("¿", MaxQuestionRunes)
	max.Options = []string{strings.Repeat("a", MaxOptionRunes), "b", "c", "d"}
	max.DurationS = MaxPollSeconds
	if err := max.Validate(); err != nil {
		t.Fatalf("límites máximos = %v, want nil", err)
	}
	min := basePoll()
	min.DurationS = MinPollSeconds
	if err := min.Validate(); err != nil {
		t.Fatalf("duración mínima = %v, want nil", err)
	}
	mut := func(f func(*PollCreate)) PollCreate { p := basePoll(); f(&p); return p }
	cases := map[string]PollCreate{
		"sin event_id":      mut(func(p *PollCreate) { p.EventID = "" }),
		"tipo":              mut(func(p *PollCreate) { p.Type = TypePollVote }),
		"pregunta vacía":    mut(func(p *PollCreate) { p.Question = "  " }),
		"pregunta larga":    mut(func(p *PollCreate) { p.Question = strings.Repeat("a", MaxQuestionRunes+1) }),
		"una opción":        mut(func(p *PollCreate) { p.Options = []string{"Sí"} }),
		"cinco opciones":    mut(func(p *PollCreate) { p.Options = []string{"a", "b", "c", "d", "e"} }),
		"opción vacía":      mut(func(p *PollCreate) { p.Options = []string{"a", " "} }),
		"opción larga":      mut(func(p *PollCreate) { p.Options = []string{"a", strings.Repeat("b", MaxOptionRunes+1)} }),
		"duración corta":    mut(func(p *PollCreate) { p.DurationS = MinPollSeconds - 1 }),
		"duración excesiva": mut(func(p *PollCreate) { p.DurationS = MaxPollSeconds + 1 }),
	}
	for name, p := range cases {
		if err := p.Validate(); err == nil {
			t.Errorf("%s: Validate() = nil, want error", name)
		}
	}
}

func TestPollCreateNormalized(t *testing.T) {
	p := basePoll()
	p.Question = "  ¿Pizza?  "
	p.Options = []string{" sí ", "no\n"}
	q, opts := p.Normalized()
	if q != "¿Pizza?" || opts[0] != "sí" || opts[1] != "no" {
		t.Fatalf("Normalized() = %q %q, want recortados", q, opts)
	}
}

func TestPollVoteAndCloseValidate(t *testing.T) {
	one := 1
	neg := -1
	if err := (PollVote{EventID: "v", Type: TypePollVote, PollID: "p", Option: &one}).Validate(); err != nil {
		t.Fatalf("voto válido = %v", err)
	}
	for name, v := range map[string]PollVote{
		"sin event_id": {Type: TypePollVote, PollID: "p", Option: &one},
		"tipo":         {EventID: "v", Type: TypePollClose, PollID: "p", Option: &one},
		"sin poll_id":  {EventID: "v", Type: TypePollVote, Option: &one},
		"sin opción":   {EventID: "v", Type: TypePollVote, PollID: "p"},
		"negativa":     {EventID: "v", Type: TypePollVote, PollID: "p", Option: &neg},
	} {
		if err := v.Validate(); err == nil {
			t.Errorf("%s: Validate() = nil, want error", name)
		}
	}
	if err := (PollClose{EventID: "c", Type: TypePollClose, PollID: "p"}).Validate(); err != nil {
		t.Fatalf("cierre válido = %v", err)
	}
	for name, c := range map[string]PollClose{
		"sin event_id": {Type: TypePollClose, PollID: "p"},
		"tipo":         {EventID: "c", Type: TypePollVote, PollID: "p"},
		"sin poll_id":  {EventID: "c", Type: TypePollClose},
	} {
		if err := c.Validate(); err == nil {
			t.Errorf("%s: Validate() = nil, want error", name)
		}
	}
}
