package server

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/auth"
)

var (
	hostKeyOnce sync.Once
	hostKey     *rsa.PrivateKey
)

func testHostKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	hostKeyOnce.Do(func() {
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			panic(err)
		}
		hostKey = k
	})
	return hostKey
}

func b64JSON(v any) string {
	raw, _ := json.Marshal(v)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func hostToken(t *testing.T, key *rsa.PrivateKey, sub, name string) string {
	t.Helper()
	now := time.Now()
	signing := b64JSON(map[string]string{"alg": "RS256", "kid": "k1", "typ": "JWT"}) + "." + b64JSON(map[string]any{
		"sub": sub, "name": name, "aud": "tint-login", "iss": "https://securetoken.google.com/tint-login",
		"iat": now.Add(-time.Minute).Unix(), "exp": now.Add(time.Hour).Unix(),
	})
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return signing + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func dialStatus(t *testing.T, url, token string) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: map[string][]string{"Authorization": {"Bearer " + token}},
	})
	if err == nil {
		c.Close(websocket.StatusNormalClosure, "")
		return 101
	}
	if resp == nil {
		t.Fatalf("dial sin respuesta: %v", err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

// Reproduce el ataque confirmado en vivo: un token Firebase con firma
// inventada abría /ws/social y chateaba como "Host Falso".
func TestSocialRejectsForgedHostToken(t *testing.T) {
	deps := testDeps("s3cr3t")
	deps.HostKeys = auth.StaticKeys{"k1": &testHostKey(t).PublicKey}
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	url := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"

	now := time.Now()
	header := b64JSON(map[string]string{"alg": "RS256", "kid": "k1", "typ": "JWT"})
	payload := b64JSON(map[string]any{
		"sub": "victima", "name": "Host Falso", "aud": "tint-login",
		"iss": "https://securetoken.google.com/tint-login",
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
	})
	forged := header + "." + payload + ".firma-falsa"
	if got := dialStatus(t, url, forged); got != 401 {
		t.Fatalf("host token falsificado: status = %d, want 401", got)
	}
	// El mismo payload con header HS256 (firma inválida) tampoco cae al camino de host.
	hs := b64JSON(map[string]string{"alg": "HS256", "typ": "JWT"}) + "." + payload + ".firma-falsa"
	if got := dialStatus(t, url, hs); got != 401 {
		t.Fatalf("HS256 inválido: status = %d, want 401", got)
	}
}

func TestSocialAcceptsVerifiedHostToken(t *testing.T) {
	deps := testDeps("s3cr3t")
	deps.HostKeys = auth.StaticKeys{"k1": &testHostKey(t).PublicKey}
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	url := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dial(t, url, hostToken(t, testHostKey(t), "uid-1", "Ana"))
	defer c.Close(websocket.StatusNormalClosure, "")
	_ = readJSON(t, c) // history
	if m := readJSON(t, c); m["type"] != "notice" || m["nick"] != "Ana" {
		t.Fatalf("aviso = %v, want joined de Ana", m)
	}
}

func TestSocialHostRejectedWithoutProjectID(t *testing.T) {
	deps := testDeps("s3cr3t")
	deps.FirebaseProjectID = ""
	deps.HostKeys = auth.StaticKeys{"k1": &testHostKey(t).PublicKey}
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	url := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	if got := dialStatus(t, url, hostToken(t, testHostKey(t), "uid-1", "Ana")); got != 401 {
		t.Fatalf("sin FIREBASE_PROJECT_ID: status = %d, want 401", got)
	}
}
