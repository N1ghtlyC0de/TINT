package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// guestTokenAs emite un guest token con nick personalizado.
func guestTokenAs(t *testing.T, secret, sub, nick, room string, exp time.Time) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	raw, _ := json.Marshal(map[string]any{"sub": sub, "room_id": room, "role": "participant", "nick": nick, "exp": exp.Unix()})
	body := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(header + "." + body))
	return header + "." + body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// collector bombea mensajes en background a un canal.
//
// Importante (nhooyr v1.8.17): expirar/cancelar el contexto de un Read
// cierra la conexión (timeoutLoop). Por eso los "esperar nada 300ms" se
// hacen con select sobre el canal y NUNCA con un Read con timeout corto:
// la conexión del test seguiría sana para las siguientes lecturas.
type collector struct {
	ch chan map[string]any
}

func collectConn(c *websocket.Conn) *collector {
	col := &collector{ch: make(chan map[string]any, 128)}
	go func() {
		for {
			// Timeout generoso: en la práctica nunca salta; si salta, el
			// test ya falló por otro lado y la conexión se puede perder.
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			_, raw, err := c.Read(ctx)
			cancel()
			if err != nil {
				return
			}
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err != nil {
				continue
			}
			col.ch <- m
		}
	}()
	return col
}

// next espera un mensaje hasta timeout; false = silencio (sin tocar la conexión).
func (col *collector) next(timeout time.Duration) (map[string]any, bool) {
	select {
	case m := <-col.ch:
		return m, true
	case <-time.After(timeout):
		return nil, false
	}
}

func expectNoticeCol(t *testing.T, col *collector, kind, nick string) map[string]any {
	t.Helper()
	m, ok := col.next(5 * time.Second)
	if !ok {
		t.Fatalf("no llegó el notice %s de %s (timeout)", kind, nick)
	}
	if m["type"] != "notice" || m["kind"] != kind || m["nick"] != nick {
		t.Fatalf("notice = %v, want kind=%s nick=%s", m, kind, nick)
	}
	if m["room_id"] != "r1" || m["user_id"] == nil || m["user_id"] == "" {
		t.Fatalf("notice = %v, want room_id y user_id", m)
	}
	return m
}

func expectSilence(t *testing.T, cols ...*collector) {
	t.Helper()
	for _, col := range cols {
		if m, ok := col.next(300 * time.Millisecond); ok {
			t.Fatalf("llegó mensaje inesperado = %v, want silencio", m)
		}
	}
}

func TestSocialJoinNoticeWithNick(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.LeaveGrace = 300 * time.Millisecond
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	exp := time.Now().Add(time.Hour)

	a := dial(t, wsBase, guestTokenAs(t, secret, "guest:ana", "Ana", "r1", exp))
	defer a.Close(websocket.StatusNormalClosure, "")
	colA := collectConn(a)
	if m, ok := colA.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje = %v, want history", m)
	}
	expectNoticeCol(t, colA, "joined", "Ana")

	pedro := dial(t, wsBase, guestTokenAs(t, secret, "guest:pedro", "Pedro", "r1", exp))
	defer pedro.Close(websocket.StatusNormalClosure, "")
	colP := collectConn(pedro)
	if m, ok := colP.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje Pedro = %v, want history", m)
	}
	expectNoticeCol(t, colP, "joined", "Pedro")
	// Ana se entera de que Pedro entró.
	expectNoticeCol(t, colA, "joined", "Pedro")
}

func TestSocialLeaveNotice(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.LeaveGrace = 300 * time.Millisecond
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	exp := time.Now().Add(time.Hour)

	a := dial(t, wsBase, guestTokenAs(t, secret, "guest:ana", "Ana", "r1", exp))
	defer a.Close(websocket.StatusNormalClosure, "")
	colA := collectConn(a)
	if m, ok := colA.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje = %v, want history", m)
	}
	expectNoticeCol(t, colA, "joined", "Ana")

	b := dial(t, wsBase, guestTokenAs(t, secret, "guest:pedro", "Pedro", "r1", exp))
	colB := collectConn(b)
	if m, ok := colB.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje B = %v, want history", m)
	}
	expectNoticeCol(t, colB, "joined", "Pedro")
	expectNoticeCol(t, colA, "joined", "Pedro")

	if err := b.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close: %v", err)
	}
	// Ana se entera de que Pedro salió.
	expectNoticeCol(t, colA, "left", "Pedro")
}

func TestSocialSameUserTwiceEmitsOnce(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.LeaveGrace = 300 * time.Millisecond
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	exp := time.Now().Add(time.Hour)

	a := dial(t, wsBase, guestTokenAs(t, secret, "guest:ana", "Ana", "r1", exp))
	defer a.Close(websocket.StatusNormalClosure, "")
	colA := collectConn(a)
	if m, ok := colA.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje = %v, want history", m)
	}
	expectNoticeCol(t, colA, "joined", "Ana")

	b := dial(t, wsBase, guestTokenAs(t, secret, "guest:pedro", "Pedro", "r1", exp))
	defer b.Close(websocket.StatusNormalClosure, "")
	colB := collectConn(b)
	if m, ok := colB.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje B = %v, want history", m)
	}
	expectNoticeCol(t, colB, "joined", "Pedro")
	expectNoticeCol(t, colA, "joined", "Pedro")

	// Segunda pestaña del mismo usuario: sin avisos extra para nadie.
	a2 := dial(t, wsBase, guestTokenAs(t, secret, "guest:ana", "Ana", "r1", exp))
	defer a2.Close(websocket.StatusNormalClosure, "")
	if m := readJSON(t, a2); m["type"] != "history" {
		t.Fatalf("primer mensaje A2 = %v, want history", m)
	}
	expectSilence(t, colA, colB)

	// Cierra una pestaña: sigue dentro, sin aviso de salida.
	if err := a2.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close: %v", err)
	}
	expectSilence(t, colA, colB)

	// Cierra la última: ahora sí hay aviso.
	if err := a.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close: %v", err)
	}
	expectNoticeCol(t, colB, "left", "Ana")
}

// Reingreso dentro de la gracia (doble montaje StrictMode / refresh):
// un solo "entró", ningún "salió".
func TestSocialRejoinWithinGraceIsSilent(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.LeaveGrace = 300 * time.Millisecond
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	exp := time.Now().Add(time.Hour)

	obs := dial(t, wsBase, guestTokenAs(t, secret, "guest:obs", "Obs", "r1", exp))
	defer obs.Close(websocket.StatusNormalClosure, "")
	colObs := collectConn(obs)
	if m, ok := colObs.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje obs = %v, want history", m)
	}
	expectNoticeCol(t, colObs, "joined", "Obs")

	a := dial(t, wsBase, guestTokenAs(t, secret, "guest:drake", "Drake", "r1", exp))
	colA := collectConn(a)
	if m, ok := colA.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje A = %v, want history", m)
	}
	expectNoticeCol(t, colA, "joined", "Drake")
	expectNoticeCol(t, colObs, "joined", "Drake")

	// Primera conexión se cae y vuelve de inmediato (como StrictMode).
	if err := a.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close: %v", err)
	}
	a2 := dial(t, wsBase, guestTokenAs(t, secret, "guest:drake", "Drake", "r1", exp))
	defer a2.Close(websocket.StatusNormalClosure, "")
	if m := readJSON(t, a2); m["type"] != "history" {
		t.Fatalf("primer mensaje A2 = %v, want history", m)
	}
	// Ni "salió" ni segundo "entró" para el observador.
	expectSilence(t, colObs)
}

// Reingreso tras la gracia: cuenta como entrada nueva (y la salida sí se avisó).
func TestSocialRejoinAfterGraceEmitsAgain(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.LeaveGrace = 200 * time.Millisecond
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	exp := time.Now().Add(time.Hour)

	obs := dial(t, wsBase, guestTokenAs(t, secret, "guest:obs", "Obs", "r1", exp))
	defer obs.Close(websocket.StatusNormalClosure, "")
	colObs := collectConn(obs)
	if m, ok := colObs.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje obs = %v, want history", m)
	}
	expectNoticeCol(t, colObs, "joined", "Obs")

	a := dial(t, wsBase, guestTokenAs(t, secret, "guest:drake", "Drake", "r1", exp))
	if m := readJSON(t, a); m["type"] != "history" {
		t.Fatalf("primer mensaje A = %v, want history", m)
	}
	expectNoticeCol(t, colObs, "joined", "Drake")

	if err := a.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close: %v", err)
	}
	// La salida sí se avisa (prueba que la ventana ya pasó).
	expectNoticeCol(t, colObs, "left", "Drake")

	a2 := dial(t, wsBase, guestTokenAs(t, secret, "guest:drake", "Drake", "r1", exp))
	defer a2.Close(websocket.StatusNormalClosure, "")
	if m := readJSON(t, a2); m["type"] != "history" {
		t.Fatalf("primer mensaje A2 = %v, want history", m)
	}
	// Volver tras la gracia es una entrada nueva.
	expectNoticeCol(t, colObs, "joined", "Drake")
}
