// Package auth valida tokens de host (Firebase) e invitado para /ws/social.
//
// Fase 1: verifica firma HS256 de guest tokens (mismo JWT_SECRET de identity-api)
// y acepta host tokens Firebase por estructura (iss/aud/exp) con verificación
// completa de firma marcada como TODO (requiere JWKS RS256).
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Claims mínimos necesarios para el chat.
type Claims struct {
	Subject string
	RoomID  string
	Role    string
	Nick    string
	IsGuest bool
}

var (
	ErrMissingToken = errors.New("falta token")
	ErrInvalidToken = errors.New("token inválido")
	ErrExpired      = errors.New("token expirado")
	ErrWrongRoom    = errors.New("token no pertenece a esta sala")
)

type guestPayload struct {
	Sub    string `json:"sub"`
	RoomID string `json:"room_id"`
	Role   string `json:"role"`
	Nick   string `json:"nick"`
	Exp    int64  `json:"exp"`
}

// VerifyGuest verifica un guest token HS256 emitido por identity-api.
func VerifyGuest(token, secret, wantRoom string, now time.Time) (Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Claims{}, ErrInvalidToken
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	wantSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(wantSig), []byte(parts[2])) {
		return Claims{}, ErrInvalidToken
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	var p guestPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return Claims{}, ErrInvalidToken
	}
	if p.Sub == "" {
		return Claims{}, ErrInvalidToken
	}
	if p.Exp > 0 && now.Unix() > p.Exp {
		return Claims{}, ErrExpired
	}
	if wantRoom != "" && p.RoomID != wantRoom {
		return Claims{}, ErrWrongRoom
	}
	return Claims{Subject: p.Sub, RoomID: p.RoomID, Role: p.Role, Nick: p.Nick, IsGuest: true}, nil
}

// firebasePayload es el subset que nos interesa de un Firebase ID token.
type firebasePayload struct {
	Sub   string `json:"sub"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Exp   int64  `json:"exp"`
	Iss   string `json:"iss"`
	Aud   string `json:"aud"`
}

// ParseHostUnverified extrae claims de un Firebase ID token sin verificar firma.
//
// TODO(auth): verificar firma RS256 contra JWKS de Google antes de producción.
func ParseHostUnverified(token, projectID string, now time.Time) (Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
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
	if p.Sub == "" {
		return Claims{}, ErrInvalidToken
	}
	if projectID != "" {
		if p.Aud != projectID || p.Iss != "https://securetoken.google.com/"+projectID {
			return Claims{}, ErrInvalidToken
		}
	}
	if p.Exp > 0 && now.Unix() > p.Exp {
		return Claims{}, ErrExpired
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

// BearerToken extrae el token de un header Authorization o query ?token=.
func BearerToken(header, query string) (string, error) {
	if strings.HasPrefix(header, "Bearer ") && len(header) > 7 {
		return strings.TrimSpace(header[7:]), nil
	}
	if query != "" {
		return query, nil
	}
	return "", ErrMissingToken
}
