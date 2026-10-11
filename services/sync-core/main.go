// Command sync-core expone el canal de sincronización de reproducción de TINT.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/server"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := server.Run(ctx, os.Getenv); err != nil {
		log.Fatal(err)
	}
}
