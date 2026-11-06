"use server";

import { requireAppAccess } from "@/lib/auth/guard";
import {
  attachSharedDeviceActionSignatureTarget,
  requireSharedDeviceActorSignature,
} from "@/lib/auth/shared-device-signature";
import { validateRedemption, markRedemptionAsUsed } from "../api/redemption.api";
import type { RedemptionValidationResult } from "../api/redemption.api";

const APP_ID = "pulso";
const REDEMPTION_PERMISSION = "pulso.loyalty.points.redeem";

export interface ProcessRedemptionResult {
  success: boolean;
  redemption?: RedemptionValidationResult["redemption"];
  error?: string;
}

export async function processRedemptionAction(
  qrCode: string,
  orderId?: string,
  sharedActorPin?: string,
): Promise<ProcessRedemptionResult> {
  try {
    const code = qrCode.trim();
    if (!code.startsWith("VENTO-")) {
      return { success: false, error: "Código de redención inválido" };
    }

    // La lectura del ticket tampoco puede preceder al permiso y sede reales.
    const { supabase, operationalSession } = await requireAppAccess({
      appId: APP_ID,
      returnTo: "/scanner",
      permissionCode: [REDEMPTION_PERMISSION],
    });
    const siteId = operationalSession.siteId;
    if (!siteId) {
      return { success: false, error: "Selecciona una sede autorizada" };
    }

    // Firmar al trabajador ANTES de consultar datos del titular del QR.
    // La firma nace sin ticket vinculado y se asocia únicamente tras validar.
    const signatureResult = await requireSharedDeviceActorSignature({
      supabase,
      session: operationalSession,
      actorPin: sharedActorPin,
      appId: APP_ID,
      actionCode: "pos.loyalty.validate_redemption",
      targetTable: "pass.loyalty_redemptions",
      targetId: null,
      metadata: {
        site_id: siteId,
        order_id: orderId ?? null,
      },
    });
    if (!signatureResult.ok) {
      return { success: false, error: signatureResult.message };
    }

    const validation = await validateRedemption(
      code,
      siteId,
      signatureResult.required ? signatureResult.signatureId : null,
    );
    if (!validation.success || !validation.redemption) {
      return { success: false, error: validation.error || "Código QR inválido" };
    }

    // La firma debe estar vinculada al ticket antes del intento de consumo.
    // El RPC la vuelve a validar de forma autoritativa y transaccional.
    if (signatureResult.required) {
      const linked = await attachSharedDeviceActionSignatureTarget({
        supabase,
        signatureId: signatureResult.signatureId,
        targetTable: "pass.loyalty_redemptions",
        targetId: validation.redemption.id,
        metadata: { prepared_for_redemption: true, site_id: siteId },
      });
      if (!linked.ok) {
        return { success: false, error: "No se pudo acreditar la firma del trabajador." };
      }
    }

    const result = await markRedemptionAsUsed(validation.redemption.id, orderId, {
      siteId,
      signatureId: signatureResult.required ? signatureResult.signatureId : null,
    });
    if (!result.success) {
      return { success: false, error: result.error || "No se pudo confirmar el canje." };
    }

    // Mostrar el estado final solo después de la confirmación durable del RPC.
    return {
      success: true,
      redemption: { ...validation.redemption, status: "validated" },
    };
  } catch {
    return { success: false, error: "No se pudo confirmar la redención." };
  }
}
