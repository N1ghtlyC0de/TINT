// Command social-core expone el Canal Social (/ws/social) de TINT: chat en vivo.
package main

import (
	"log"
	"os"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/server"
)

func main() {
	log.Fatal(server.Run(os.Getenv))
}
