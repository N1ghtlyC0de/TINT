# 📚 Documentación de TINT

| Documento | Para qué leerlo |
| :--- | :--- |
| [Arquitectura del sistema](arquitectura.md) | Visión general: servicios, almacenes, contratos entre dominios, puertos y CI. **Empieza aquí.** |
| [Usuarios, identidad y permisos](usuarios-e-identidad.md) | Tipos de usuario, matriz de permisos, esquema de PostgreSQL, esquemas de tokens, flujos de login, invitación y retiro. |
| [Dominio de Reproducción](dominio-reproduccion.md) | Canal Sync v2: Reloj Maestro, comandos, drift, presencia, delegación, revocación, métricas, benchmarks y pruebas. |

Cada servicio tiene además su `AGENTS.md` con stack, límites, modelo de datos y comandos (ver la tabla en el [AGENTS.md raíz](../AGENTS.md)).

## Convenciones de esta carpeta
- Español y diagramas **Mermaid**, que GitHub renderiza.
- Un documento por feature o tema transversal. Actualízalo en el mismo PR que cambie el flujo o el contrato.
- Antes de hacer commit, verifica que los diagramas compilen (por ejemplo, en [mermaid.live](https://mermaid.live)).
- Usa nombres reales de archivos, rutas, claves Redis y tablas, y marca qué está implementado y qué está previsto.
