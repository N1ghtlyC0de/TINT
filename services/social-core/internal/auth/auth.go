// Package auth valida tokens de host (Firebase) e invitado para /ws/social.
//
// Guest tokens: HS256 con el JWT_SECRET compartido con identity-api.
// Host tokens: Firebase ID tokens RS256 verificados contra los certificados
// públicos de Google (ver firebase.go). Ante cualquier duda, se rechaza.
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
