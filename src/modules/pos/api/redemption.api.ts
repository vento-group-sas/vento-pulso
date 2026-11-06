"use server";

import { createClient } from "@/lib/supabase/server";

export interface RedemptionValidationResult {
  success: boolean;
  redemption?: {
    id: string;
    user_id: string;
    reward_id: string;
    reward_name: string;
    points_spent: number;
    status: string;
    created_at: string;
  };
  error?: string;
}

function responseObject(data: unknown): Record<string, unknown> | null {
  const value = Array.isArray(data) ? data[0] : data;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function validateRedemption(
  qrCode: string,
  siteId?: string | null,
  signatureId?: string | null,
): Promise<RedemptionValidationResult> {
  const code = qrCode.trim();
  if (!siteId || !code.startsWith("VENTO-")) {
    return { success: false, error: "Código de redención o sede inválidos" };
  }
  try {
    const supabase = await createClient();
    // PULSO never SELECTs pass.loyalty_redemptions directly. The server RPC
    // rechecks actor/site scope, status and expiry before revealing a ticket.
    const { data, error } = await supabase.schema("api").rpc(
      "pass_validate_redemption_v1",
      { p_qr_code: code, p_site_id: siteId, p_signature_id: signatureId ?? null },
    );
    if (error) return { success: false, error: "No se pudo validar el código" };
    const result = responseObject(data);
    const redemption = responseObject(result?.redemption);
    if (
      result?.success !== true ||
      typeof redemption?.id !== "string" ||
      typeof redemption?.user_id !== "string" ||
      typeof redemption?.reward_id !== "string" ||
      typeof redemption?.reward_name !== "string" ||
      typeof redemption?.points_spent !== "number" ||
      redemption?.status !== "pending" ||
      typeof redemption?.created_at !== "string"
    ) {
      return { success: false, error: "El servidor no confirmó la validez del código" };
    }
    return {
      success: true,
      redemption: {
        id: redemption.id,
        user_id: redemption.user_id,
        reward_id: redemption.reward_id,
        reward_name: redemption.reward_name,
        points_spent: redemption.points_spent,
        status: redemption.status,
        created_at: redemption.created_at,
      },
    };
  } catch {
    return { success: false, error: "No se pudo validar el código" };
  }
}

export async function markRedemptionAsUsed(
  redemptionId: string,
  orderId: string | undefined,
  context: { siteId: string; signatureId: string | null },
): Promise<{ success: boolean; error?: string }> {
  if (!context.siteId || !redemptionId) {
    return { success: false, error: "Sede o redención no disponible" };
  }
  try {
    const supabase = await createClient();
    const { data: identity, error: identityError } = await supabase.auth.getUser();
    if (identityError || !identity.user) {
      return { success: false, error: "No se pudo autenticar" };
    }
    const { data, error } = await supabase.schema("api").rpc(
      "pass_consume_redemption_v1",
      {
        p_redemption_id: redemptionId,
        p_site_id: context.siteId,
        p_order_id: orderId ?? null,
        p_signature_id: context.signatureId,
      },
    );
    if (error) {
      // Unknown commit result: the server must deduplicate retries by ticket.
      return { success: false, error: "No se pudo confirmar el canje en el servidor." };
    }
    const result = responseObject(data);
    if (result?.redemption_id !== redemptionId || result?.status !== "validated") {
      return { success: false, error: "El servidor no confirmó el consumo." };
    }
    return { success: true };
  } catch {
    return { success: false, error: "No fue posible confirmar el canje." };
  }
}
