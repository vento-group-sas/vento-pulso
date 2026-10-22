import Link from "next/link";

import { requireAppAccess } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

// Historical route only. This is NOT the native POS and cannot import external sales.
// Keep the route identity for the governed PULSO route-inventory cutover.
const LEGACY_POS_IMPORT_DISABLED = "external-pos-import-retired";

export default async function RetiredExternalSalesImportPage() {
  await requireAppAccess({
    appId: "pulso",
    returnTo: "/sales-imports",
    permissionCode: ["pos.main"],
    requireAppAccessPermission: true,
  });

  return (
    <main
      data-legacy-pos-import-disabled={LEGACY_POS_IMPORT_DISABLED}
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-10"
    >
      <h1 className="text-2xl font-semibold">Importador de ventas externas retirado</h1>
      <p className="text-sm leading-6">
        PULSO no recibe ventas ni listas de precios desde Makos u otro POS externo.
        La integración, carga de archivos, mapeos y publicación de lotes externos
        están deshabilitadas. Los registros históricos se conservan sin cambios.
      </p>
      <p className="text-sm leading-6">
        El POS nativo de PULSO sigue en desarrollo y solo podrá activarse para
        ventas reales después de su validación integral y aprobación operativa.
      </p>
      <Link href="/salon" className="ui-btn ui-btn--ghost self-start">
        Volver al salón
      </Link>
    </main>
  );
}
