package auth

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// GoogleCertsURL publica los certificados x509 (PEM) con los que Firebase
// Auth firma los ID tokens, indexados por `kid`.
const GoogleCertsURL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"

const (
	// hostLeeway tolera desfase de reloj con Google en iat/auth_time.
	hostLeeway = time.Minute
	// minRefetch limita cuántas veces se piden certificados ante un kid desconocido.
	minRefetch = time.Minute
	// fetchTimeout acota la descarga de certificados.
	fetchTimeout = 5 * time.Second
)

var (
	// ErrHostDisabled indica que no hay FIREBASE_PROJECT_ID o fuente de claves:
	// los host tokens se rechazan (falla cerrado).
	ErrHostDisabled = errors.New("verificación de host no configurada")
	// ErrUnknownKey indica que el kid no está entre las claves públicas vigentes.
	ErrUnknownKey = errors.New("kid desconocido")
)

// KeySource resuelve la clave pública RSA de un kid.
type KeySource interface {
	Key(ctx context.Context, kid string) (*rsa.PublicKey, error)
}

// StaticKeys es un KeySource fijo (pruebas y despliegues sin red).
type StaticKeys map[string]*rsa.PublicKey

// Key implementa KeySource.
func (s StaticKeys) Key(_ context.Context, kid string) (*rsa.PublicKey, error) {
	if k, ok := s[kid]; ok && k != nil {
		return k, nil
	}
	return nil, ErrUnknownKey
}

type header struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
}

func decodeHeader(token string) (header, bool) {
	i := strings.IndexByte(token, '.')
	if i <= 0 {
		return header{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(token[:i])
	if err != nil {
		return header{}, false
	}
	var h header
	if err := json.Unmarshal(raw, &h); err != nil {
		return header{}, false
	}
	return h, true
}

// TokenAlg devuelve el `alg` del header JWT ("" si no se puede leer).
// Solo sirve para elegir verificador: nunca autoriza por sí mismo.
func TokenAlg(token string) string {
	h, _ := decodeHeader(token)
	return h.Alg
}

type firebasePayload struct {
	Sub      string          `json:"sub"`
	Email    string          `json:"email"`
	Name     string          `json:"name"`
	Exp      int64           `json:"exp"`
	Iat      int64           `json:"iat"`
	AuthTime int64           `json:"auth_time"`
	Iss      string          `json:"iss"`
	Aud      json.RawMessage `json:"aud"`
}

// VerifyHost verifica un Firebase ID token según la guía de Firebase para
// librerías de terceros: RS256, firma contra la clave del `kid`, iss/aud del
// proyecto, exp e iat obligatorios y sub no vacío (≤ 128 caracteres).
func VerifyHost(ctx context.Context, token, projectID string, keys KeySource, now time.Time) (Claims, error) {
	if projectID == "" || keys == nil {
		return Claims{}, ErrHostDisabled
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Claims{}, ErrInvalidToken
	}
	h, ok := decodeHeader(token)
	if !ok || h.Alg != "RS256" || h.Kid == "" {
		return Claims{}, ErrInvalidToken
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	pub, err := keys.Key(ctx, h.Kid)
	if err != nil {
		return Claims{}, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig); err != nil {
		return Claims{}, ErrInvalidToken
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	var p firebasePayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return Claims{}, ErrInvalidToken
	}
	var aud string
	if err := json.Unmarshal(p.Aud, &aud); err != nil || aud != projectID {
		return Claims{}, ErrInvalidToken
	}
	if p.Iss != "https://securetoken.google.com/"+projectID {
		return Claims{}, ErrInvalidToken
	}
	if p.Sub == "" || len(p.Sub) > 128 {
		return Claims{}, ErrInvalidToken
	}
	if p.Exp == 0 || !now.Before(time.Unix(p.Exp, 0)) {
		return Claims{}, ErrExpired
	}
	limit := now.Add(hostLeeway).Unix()
	if p.Iat == 0 || p.Iat > limit || p.AuthTime > limit {
		return Claims{}, ErrInvalidToken
	}
	nick := p.Name
	if nick == "" {
		nick = p.Email
	}
	if nick == "" {
		nick = "Host"
	}
	return Claims{Subject: p.Sub, Nick: nick, Role: "host"}, nil
}

// GoogleCerts es un KeySource que descarga y cachea los certificados de
// Google respetando Cache-Control max-age. Ante un kid desconocido vuelve a
// pedirlos, como mucho una vez por minuto. Si no puede obtenerlos, falla.
type GoogleCerts struct {
	URL    string
	Client *http.Client
	Now    func() time.Time

	mu        sync.Mutex
	keys      map[string]*rsa.PublicKey
	expires   time.Time
	lastFetch time.Time
}

// NewGoogleCerts crea la fuente de claves (url vacía = GoogleCertsURL).
func NewGoogleCerts(url string, client *http.Client) *GoogleCerts {
	if url == "" {
		url = GoogleCertsURL
	}
	if client == nil {
		client = &http.Client{Timeout: fetchTimeout}
	}
	return &GoogleCerts{URL: url, Client: client}
}

func (g *GoogleCerts) now() time.Time {
	if g.Now != nil {
		return g.Now()
	}
	return time.Now()
}

// Key implementa KeySource.
func (g *GoogleCerts) Key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	fresh := now.Before(g.expires)
	if k, ok := g.keys[kid]; ok && fresh {
		return k, nil
	}
	if !g.lastFetch.IsZero() && now.Sub(g.lastFetch) < minRefetch {
		return nil, ErrUnknownKey
	}
	g.lastFetch = now
	keys, ttl, err := g.fetch(ctx)
	if err != nil {
		return nil, err
	}
	if ttl < minRefetch {
		ttl = minRefetch // sin max-age no se martillea a Google ni se rechaza lo conocido
	}
	g.keys, g.expires = keys, now.Add(ttl)
	if k, ok := keys[kid]; ok {
		return k, nil
	}
	return nil, ErrUnknownKey
}

func (g *GoogleCerts) fetch(ctx context.Context) (map[string]*rsa.PublicKey, time.Duration, error) {
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.URL, nil)
	if err != nil {
		return nil, 0, err
	}
	resp, err := g.Client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("certificados de Google: HTTP %d", resp.StatusCode)
	}
	var pems map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&pems); err != nil {
		return nil, 0, err
	}
	keys := make(map[string]*rsa.PublicKey, len(pems))
	for kid, raw := range pems {
		block, _ := pem.Decode([]byte(raw))
		if block == nil {
			return nil, 0, fmt.Errorf("certificado %q no es PEM", kid)
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, 0, err
		}
		pub, ok := cert.PublicKey.(*rsa.PublicKey)
		if !ok {
			return nil, 0, fmt.Errorf("certificado %q sin clave RSA", kid)
		}
		keys[kid] = pub
	}
	return keys, maxAge(resp.Header.Get("Cache-Control")), nil
}

// maxAge extrae max-age de Cache-Control (0 si falta o es inválido).
func maxAge(cc string) time.Duration {
	for _, part := range strings.Split(cc, ",") {
		part = strings.TrimSpace(part)
		if v, ok := strings.CutPrefix(part, "max-age="); ok {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				return time.Duration(n) * time.Second
			}
		}
	}
	return 0
}
