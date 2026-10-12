package auth

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const project = "tint-login"

var (
	keyOnce sync.Once
	testKey *rsa.PrivateKey
)

func rsaKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	keyOnce.Do(func() {
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			panic(err)
		}
		testKey = k
	})
	return testKey
}

func b64(v any) string {
	raw, _ := json.Marshal(v)
	return base64.RawURLEncoding.EncodeToString(raw)
}

// signHost firma un Firebase ID token RS256 con la clave de prueba.
func signHost(t *testing.T, key *rsa.PrivateKey, kid string, now time.Time, mutate func(map[string]any)) string {
	t.Helper()
	claims := map[string]any{
		"sub": "uid-1", "name": "Ana", "email": "a@b.c",
		"iss": "https://securetoken.google.com/" + project, "aud": project,
		"iat": now.Add(-time.Minute).Unix(), "exp": now.Add(time.Hour).Unix(),
		"auth_time": now.Add(-time.Minute).Unix(),
	}
	if mutate != nil {
		mutate(claims)
	}
	signing := b64(map[string]string{"alg": "RS256", "kid": kid, "typ": "JWT"}) + "." + b64(claims)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return signing + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func TestVerifyHostValid(t *testing.T) {
	key := rsaKey(t)
	now := time.Now()
	keys := StaticKeys{"k1": &key.PublicKey}
	got, err := VerifyHost(context.Background(), signHost(t, key, "k1", now, nil), project, keys, now)
	if err != nil {
		t.Fatalf("VerifyHost = %v", err)
	}
	if got.Subject != "uid-1" || got.Nick != "Ana" || got.Role != "host" || got.IsGuest {
		t.Fatalf("claims = %+v", got)
	}
	// Sin name usa el email; sin ambos, "Host".
	tok := signHost(t, key, "k1", now, func(c map[string]any) { delete(c, "name") })
	if got, _ := VerifyHost(context.Background(), tok, project, keys, now); got.Nick != "a@b.c" {
		t.Fatalf("nick sin name = %q", got.Nick)
	}
	tok = signHost(t, key, "k1", now, func(c map[string]any) { delete(c, "name"); delete(c, "email") })
	if got, _ := VerifyHost(context.Background(), tok, project, keys, now); got.Nick != "Host" {
		t.Fatalf("nick por defecto = %q", got.Nick)
	}
}

// Reproduce el ataque confirmado en vivo: payload correcto, firma inventada.
func TestVerifyHostRejectsForgedSignature(t *testing.T) {
	key := rsaKey(t)
	now := time.Now()
	header := b64(map[string]string{"alg": "RS256", "kid": "k1", "typ": "JWT"})
	payload := b64(map[string]any{
		"sub": "victima", "name": "Host Falso", "aud": project,
		"iss": "https://securetoken.google.com/" + project,
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
	})
	forged := header + "." + payload + "." + base64.RawURLEncoding.EncodeToString([]byte("firma-falsa"))
	if _, err := VerifyHost(context.Background(), forged, project, StaticKeys{"k1": &key.PublicKey}, now); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("firma falsa debe fallar con ErrInvalidToken, got %v", err)
	}
	// Mismo payload firmado con OTRA clave.
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	if _, err := VerifyHost(context.Background(), signHost(t, other, "k1", now, nil), project, StaticKeys{"k1": &key.PublicKey}, now); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("firma de otra clave debe fallar, got %v", err)
	}
}

func TestVerifyHostRejectsBadClaims(t *testing.T) {
	key := rsaKey(t)
	now := time.Now()
	keys := StaticKeys{"k1": &key.PublicKey}
	cases := map[string]func(map[string]any){
		"aud ajeno":    func(c map[string]any) { c["aud"] = "otro" },
		"iss ajeno":    func(c map[string]any) { c["iss"] = "https://securetoken.google.com/otro" },
		"sin sub":      func(c map[string]any) { c["sub"] = "" },
		"sub largo":    func(c map[string]any) { c["sub"] = string(make([]byte, 129)) },
		"sin exp":      func(c map[string]any) { delete(c, "exp") },
		"expirado":     func(c map[string]any) { c["exp"] = now.Add(-time.Second).Unix() },
		"sin iat":      func(c map[string]any) { delete(c, "iat") },
		"iat futuro":   func(c map[string]any) { c["iat"] = now.Add(time.Hour).Unix() },
		"auth futuro":  func(c map[string]any) { c["auth_time"] = now.Add(time.Hour).Unix() },
		"aud no texto": func(c map[string]any) { c["aud"] = 7 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := VerifyHost(context.Background(), signHost(t, key, "k1", now, mutate), project, keys, now); err == nil {
				t.Fatal("debe fallar")
			}
		})
	}
}

func TestVerifyHostRejectsBadHeaderAndConfig(t *testing.T) {
	key := rsaKey(t)
	now := time.Now()
	keys := StaticKeys{"k1": &key.PublicKey}
	good := signHost(t, key, "k1", now, nil)
	if _, err := VerifyHost(context.Background(), good, "", keys, now); !errors.Is(err, ErrHostDisabled) {
		t.Fatalf("sin FIREBASE_PROJECT_ID debe fallar cerrado, got %v", err)
	}
	if _, err := VerifyHost(context.Background(), good, project, nil, now); !errors.Is(err, ErrHostDisabled) {
		t.Fatalf("sin fuente de claves debe fallar cerrado, got %v", err)
	}
	if _, err := VerifyHost(context.Background(), signHost(t, key, "desconocido", now, nil), project, keys, now); err == nil {
		t.Fatal("kid desconocido debe fallar")
	}
	// alg distinto de RS256 (p. ej. none/HS256) no se acepta como host.
	for _, alg := range []string{"none", "HS256", "RS512"} {
		h := b64(map[string]string{"alg": alg, "kid": "k1"})
		parts := splitToken(good)
		if _, err := VerifyHost(context.Background(), h+"."+parts[1]+"."+parts[2], project, keys, now); err == nil {
			t.Fatalf("alg %s debe fallar", alg)
		}
	}
	for _, bad := range []string{"mal", "a.b.c", "!!.!!.!!", b64(map[string]string{"alg": "RS256", "kid": "k1"}) + ".!!.sig"} {
		if _, err := VerifyHost(context.Background(), bad, project, keys, now); err == nil {
			t.Fatalf("token %q debe fallar", bad)
		}
	}
}

func splitToken(tok string) []string {
	out := []string{}
	start := 0
	for i := 0; i < len(tok); i++ {
		if tok[i] == '.' {
			out = append(out, tok[start:i])
			start = i + 1
		}
	}
	return append(out, tok[start:])
}

func TestTokenAlg(t *testing.T) {
	if alg := TokenAlg(b64(map[string]string{"alg": "RS256"}) + ".x.y"); alg != "RS256" {
		t.Fatalf("alg = %q", alg)
	}
	for _, bad := range []string{"", "x", "!!.x.y", b64("no-obj") + ".x.y"} {
		if alg := TokenAlg(bad); alg != "" {
			t.Fatalf("TokenAlg(%q) = %q, want vacío", bad, alg)
		}
	}
}

// certPEM emite un certificado autofirmado con la clave pública dada.
func certPEM(t *testing.T, key *rsa.PrivateKey) string {
	t.Helper()
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "securetoken"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

type certServer struct {
	srv    *httptest.Server
	hits   atomic.Int32
	mu     sync.Mutex
	certs  map[string]string
	status int
	maxAge string
}

func newCertServer(t *testing.T, certs map[string]string) *certServer {
	t.Helper()
	cs := &certServer{certs: certs, status: http.StatusOK, maxAge: "max-age=3600"}
	cs.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		cs.hits.Add(1)
		cs.mu.Lock()
		defer cs.mu.Unlock()
		w.Header().Set("Cache-Control", "public, "+cs.maxAge+", must-revalidate")
		w.WriteHeader(cs.status)
		_ = json.NewEncoder(w).Encode(cs.certs)
	}))
	t.Cleanup(cs.srv.Close)
	return cs
}

func (cs *certServer) set(certs map[string]string, status int, maxAge string) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	cs.certs, cs.status, cs.maxAge = certs, status, maxAge
}

func TestGoogleCertsCachesAndRefetches(t *testing.T) {
	key := rsaKey(t)
	cs := newCertServer(t, map[string]string{"k1": certPEM(t, key)})
	clock := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	g := NewGoogleCerts(cs.srv.URL, cs.srv.Client())
	g.Now = func() time.Time { return clock }

	ctx := context.Background()
	pub, err := g.Key(ctx, "k1")
	if err != nil || pub.N.Cmp(key.PublicKey.N) != 0 {
		t.Fatalf("Key = %v, %v", pub, err)
	}
	if _, err := g.Key(ctx, "k1"); err != nil || cs.hits.Load() != 1 {
		t.Fatalf("segunda consulta debe salir de caché (hits=%d, err=%v)", cs.hits.Load(), err)
	}
	// kid desconocido: refetch, pero con límite de tasa.
	if _, err := g.Key(ctx, "k2"); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("kid desconocido = %v", err)
	}
	if cs.hits.Load() != 1 {
		t.Fatalf("refetch dentro del límite de tasa (hits=%d)", cs.hits.Load())
	}
	clock = clock.Add(2 * time.Minute)
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	cs.set(map[string]string{"k1": certPEM(t, key), "k2": certPEM(t, other)}, http.StatusOK, "max-age=60")
	if _, err := g.Key(ctx, "k2"); err != nil || cs.hits.Load() != 2 {
		t.Fatalf("kid nuevo tras rotación = %v (hits=%d)", err, cs.hits.Load())
	}
	// Caducado el max-age (60 s) se vuelve a pedir; si Google falla, se rechaza (falla cerrado).
	clock = clock.Add(2 * time.Minute)
	cs.set(nil, http.StatusInternalServerError, "max-age=60")
	if _, err := g.Key(ctx, "k1"); err == nil {
		t.Fatal("con certificados caducados y Google caído debe fallar")
	}
}

func TestGoogleCertsRejectsGarbage(t *testing.T) {
	cs := newCertServer(t, map[string]string{"k1": "no-es-pem"})
	g := NewGoogleCerts(cs.srv.URL, cs.srv.Client())
	if _, err := g.Key(context.Background(), "k1"); err == nil {
		t.Fatal("PEM inválido debe fallar")
	}
	bad := NewGoogleCerts("http://127.0.0.1:1/certs", nil)
	if _, err := bad.Key(context.Background(), "k1"); err == nil {
		t.Fatal("sin red debe fallar")
	}
}

func TestMaxAge(t *testing.T) {
	cases := map[string]time.Duration{
		"public, max-age=19302, must-revalidate": 19302 * time.Second,
		"max-age=0":                              0,
		"no-cache":                               0,
		"max-age=abc":                            0,
		"":                                       0,
	}
	for in, want := range cases {
		if got := maxAge(in); got != want {
			t.Errorf("maxAge(%q) = %v, want %v", in, got, want)
		}
	}
}
