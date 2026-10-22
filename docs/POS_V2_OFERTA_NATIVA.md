# PULSO — POS V2 nativo | oferta gobernada y cotización (fase de ingeniería)

**Estado:** `CODE_CANDIDATE / QA_PENDING`. **POS V2 como sistema:** `NO_IMPLEMENTADO`. **Ambiente de ejecución:** módulos puros y datos sintéticos, **sin rutas, tablas nuevas, ventas, pagos ni despliegue**. No existe autorización para habilitar un POS comercial parcial.

## 1. Autoridad y fuentes

- [Tablero de los 69 procesos — #1038](https://github.com/vento-group-sas/vento-shell/issues/1038): el POS de VENTO OS V1 fue descartado; la V2 es una implementación nueva.
- [Paquetes compartidos — #1020](https://github.com/vento-group-sas/vento-shell/issues/1020): contratos, distribución e integración técnica, separados del progreso empresarial.
- Registro canónico `TREQ-PULSO-001`: operación integral de venta/caja/pagos/stock/fidelidad/contabilidad antes de producción.
- `TREQ-PULSO-003`: ninguna estructura o RPC V1 se convierte en componente V2 por existir; exige seguridad, atomicidad, idempotencia, recuperación y aceptación.
- `TREQ-PULSO-004/005/006`: acciones nombradas, versionado de oferta, datos y estados separados, comprobantes, caja y compensaciones.
- `VPROC-0017` (oferta PULSO) y `VPROC-0038/0039/0040/0042/0043/0044` (servicio, venta, canales, reversa, pagos y caja). Se mantienen los propietarios y 12 gates `PROC-COVER-007`.

**Decisión vigente:** POS nativo 100 % en PULSO; **NO** integración con Makos/otro POS externo, ni XLSX, mapeos o matriz de precios de proveedor. Los proveedores de pagos/fiscalidad y canales externos de pedido no son otro POS.

## 2. Código realmente desarrollado

`src/modules/pos-v2/domain/offer.mjs` es un **dominio de oferta nuevo e independiente** del legado. No importa `src/modules/pos`, tablas `pos.*`, `pass.catalog_items`, `internal_price_*` ni `process_order_payment`.

| Función | Comportamiento técnico |
| --- | --- |
| `createOfferDraft` | Crea oferta V2 en `DRAFT`, asociada a **sede PULSO + producto NEXO + receta FOGO opcional**, canales permitidos, precio propio COP, impuesto/ descuento y vigencia; conserva primer evento de auditoría. |
| `transitionOffer` | Controla `APPROVE`, `PUBLISH`, `SUSPEND`, `RESUME`, `REVISE`, `RETIRE`. Valida transición, contexto territorial, actor y **decisión de autorización suministrada por un servidor confiable**; exige motivo al suspender/retirar; versiona revisión y elimina aprobación previa. No permite reactivar `RETIRED`. |
| `assessOffer` | Rechaza oferta no publicada, sede/canal diferentes, vigencia vencida, disponibilidad NEXO ausente/insuficiente/caducada y preparación FOGO ausente/caducada cuando aplica. La respuesta es **solo evaluación preliminar**, no reserva de existencias. |
| `quotePublishedOffer` | Emite snapshot **inmutable**, con versión de oferta, referencias de evidencia NEXO/FOGO, cantidades en milésimas, importes COP enteros, descuento e impuesto incluido o excluido, redondeo comercial y vencimiento. Estado `PREVIEW_NOT_RESERVED`. **No crea pedido, transacción ni pago.** |

### Máquina de estados de la oferta (dominio, no publicación a canales)

```text
DRAFT --APPROVE--> APPROVED --PUBLISH--> PUBLISHED
DRAFT/APPROVED/SUSPENDED --REVISE--> DRAFT (versión + 1)
PUBLISHED --SUSPEND(motivo)--> SUSPENDED --RESUME--> PUBLISHED
DRAFT/APPROVED/PUBLISHED/SUSPENDED --RETIRE(motivo)--> RETIRED
RETIRED --> sin transición
```

**Fronteras y decisiones deliberadas:** el dominio exige COP y valores enteros en pesos, cantidades enteras en milésimas, impuestos representados en puntos básicos y canales enumerados. Los redondeos se realizan con `BigInt` y *half-up*; los cálculos con overflow se rechazan. **Esta regla de redondeo es candidata de ingeniería**, no reemplaza validación tributaria ni configuración fiscal definitiva. El costo/receta no define el precio de venta. El precio autoritativo deberá originarse en PULSO; señales de disponibilidad provendrán de NEXO y de FOGO según proceso. Canales permitidos hoy por el contrato del módulo: `counter`, `table`, `pickup`, `delivery`, `web`, `marketplace`, `messaging`. Ninguno corresponde a POS externo.

**Limitación fundamental:** la estructura `decision` (permiso, actor, sede, tipo, vencimiento, ID) y las evidencias NEXO/FOGO son **inputs del dominio**, no credenciales firmadas ni pruebas de permisos. En producción **solo el backend confiable** podrá resolverlas y revalidarlas contra autorización y datos vigentes. Los fixtures de la demo **no** garantizan permisos, reserva, preparación, disponibilidad real ni que una venta vaya a completarse.

## 3. Ejecutar la prueba funcional sintética

Desde la raíz del repositorio PULSO, con las dependencias fijadas:

```bash
npm run test:pos-v2
npm run pos:v2:demo
npm test
npm run typecheck
npm run lint
npm run build
```

El escenario determinista crea una oferta, la aprueba, la publica, evalúa disponibilidad **sintética** de NEXO/FOGO y emite un presupuesto COP. El JSON deja explícitos `actualInventoryReserved:false`, `moneyCaptured:false`, `saleCommitted:false`, `productionEnabled:false`.

Las pruebas `V2-01..V2-29` cubren flujo positivo y casos negativos: sobreescritura de campos, errores de precio/impuestos, permisos mal asignados, transitions inválidas, motivos, cambios de versión, inventario no comprobado, receta no preparada, sede/canal erróneos, vigencias, cantidades fraccionarias, redondeos, overflow y rechazo del POS externo. `npm test` ejecuta **la suite histórica CI010 sin alterar su denominador**, más esta suite V2 en un carril separado. Los resultados **solo acreditan lógica de dominio en el SHA probado**, nunca E2E empresarial.

## 4. Lo que NO está implementado ni aprobado para operación

| Capa | Estado | Trabajo de continuidad |
| --- | --- | --- |
| UI comercial V2 y permisos navegables | **PENDING** | Diseño de flujo de oferta y pantallas propias con AUTH-UI e inventario gobernado; no agregar rutas silenciosamente. |
| Persistencia y fuente autoritativa de ofertas | **PENDING** | Esquema **V2 independiente** con RLS, revisiones, vigencia, aprobación, transiciones atómicas y auditoría, sin adoptar tablas V1 por nombre. |
| Autorización efectiva | **PENDING** | Servicio/API nombrada con permisos por acción, sede, actor y dispositivo; nunca aceptar `decision` de un cliente. |
| Disponibilidad NEXO / recetas FOGO | **PENDING** | Contratos reales, reserva atómica, liberación/compensación, deduplicación, contingencias y pruebas con propietarios; evidencia sintética no sirve para confirmar pedidos. |
| Carrito, pedido, comanda, venta y caja | **NO_IMPLEMENTADO** | Ciclos independientes con integraciones, snapshots, colas y estados; no registrar un presupuesto como venta. |
| Pagos, propinas, mixtos, fiscal y devoluciones | **NO_IMPLEMENTADO** | Proveedores autorizados, conciliación, idempotencia persistida, refund/reversa y pruebas negativas reales. |
| Efectos NEXO/FOGO/PASS/NUMERA | **PENDING** | Outbox/reintentos/reconciliación con semánticas propietarias versionadas. |
| Seguridad de superficies V1 | **LEGACY / AUDIT_REQUIRED** | Inventario de consumidores de `process_order_payment`, RPC de importación y políticas; contención y retiro gobernados sin borrar datos históricos. |
| 12 gates y rollout comercial | **NOT_EVALUATED** | Pruebas E2E por sede, rol, dispositivo, canal, excepción, corrección, auditoría y aceptación. No activar POS parcial. |

## 5. Criterio de salida de esta fase y siguiente acción

Esta fase de ingeniería solo estará **QA_TECNICA_PASS** tras `test:pos-v2`, `npm test`, tipos, lint, build y Required Gate del **commit exacto**. El PR permanecerá **DRAFT**, sin merge ni deploy hasta las autorizaciones correspondientes. Ningún `VPROC` se considera `COMPLETE`.

**Siguiente incremento recomendado:** diseñar y construir la **persistencia V2 de oferta** con esquema físicamente aislado, permisos de publicación y acciones nombradas, tras validar las reglas comerciales/fiscales y las dependencias NEXO/FOGO. Solo después unirlo a la creación de pedidos, comandas, cobros y cierre integral. El repositorio Shell conserva el gobierno de migraciones y gates E5; no se aplican cambios en Supabase DEV/PROD en esta fase.
