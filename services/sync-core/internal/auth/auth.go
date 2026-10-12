// Package auth valida los tokens del handshake de /ws/sync (SYNC-BE-01).
//
// Acepta dos emisores de identity-api firmados con HS256 y JWT_SECRET:
// el guest token (role=participant) y el sync-ticket del Host (role=host).
package auth

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Role es el rol del usuario dentro de la sala.
type Role string

const (
	RoleHost        Role = "host"
	RoleCohost      Role = "cohost"
	RoleParticipant Role = "participant"
)

var (
	ErrInvalidToken = errors.New("token inválido")
	ErrRoomMismatch = errors.New("el token no pertenece a esta sala")
	ErrUnknownRole  = errors.New("rol desconocido")
	// ErrTokenExpired: firma, iss y aud válidos pero exp vencido. Envuelve
	// ErrInvalidToken para que quien no lo distinga lo siga rechazando.
	ErrTokenExpired = fmt.Errorf("%w: expirado", ErrInvalidToken)
)

// Claims es la identidad verificada de una conexión.
type Claims struct {
	Sub    string
	RoomID string
	Role   Role
	Nick   string
	JTI    string // id del token: permite revocarlo (identity-api)
}

// CanControl indica si el rol puede emitir PLAY/PAUSE/SEEK.
func (c Claims) CanControl() bool {
	return c.Role == RoleHost || c.Role == RoleCohost
}

type tokenClaims struct {
	jwt.RegisteredClaims
	RoomID string `json:"room_id"`
	Role   Role   `json:"role"`
	Nick   string `json:"nick"`
}

// Verifier valida tokens HS256 de identity-api.
type Verifier struct {
	secret   []byte
	issuer   string
	audience string
	now      func() time.Time
}

// NewVerifier crea un Verifier con el secreto compartido.
func NewVerifier(secret, issuer, audience string) *Verifier {
	return &Verifier{secret: []byte(secret), issuer: issuer, audience: audience, now: time.Now}
}

// Verify valida firma, algoritmo, iss, aud, exp y que el token sea de roomID.
//
// Un token bien firmado (iss y aud correctos) cuyo único defecto es el exp
// vencido devuelve ErrTokenExpired, pero solo si además pasa las comprobaciones
// de sub, sala y rol: así un token ajeno nunca se distingue de uno inválido.
func (v *Verifier) Verify(token, roomID string) (Claims, error) {
	tc, err := v.parse(token, v.now)
	expired := false
	if errors.Is(err, jwt.ErrTokenExpired) && tc.ExpiresAt != nil {
		// Revalida todo lo demás en el último instante de vigencia.
		exp := tc.ExpiresAt.Time
		if tc, err = v.parse(token, func() time.Time { return exp.Add(-time.Second) }); err == nil {
			expired = true
		}
	}
	if err != nil {
		return Claims{}, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}
	if tc.Subject == "" {
		return Claims{}, fmt.Errorf("%w: sub vacío", ErrInvalidToken)
	}
	if tc.RoomID != roomID {
		return Claims{}, ErrRoomMismatch
	}
	switch tc.Role {
	case RoleHost, RoleCohost, RoleParticipant:
	default:
		return Claims{}, fmt.Errorf("%w: %q", ErrUnknownRole, tc.Role)
	}
	if expired {
		return Claims{}, ErrTokenExpired
	}
	return Claims{Sub: tc.Subject, RoomID: tc.RoomID, Role: tc.Role, Nick: tc.Nick, JTI: tc.ID}, nil
}

func (v *Verifier) parse(token string, now func() time.Time) (tokenClaims, error) {
	var tc tokenClaims
	_, err := jwt.ParseWithClaims(token, &tc,
		func(*jwt.Token) (any, error) { return v.secret, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(v.audience),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(now),
	)
	return tc, err
}
