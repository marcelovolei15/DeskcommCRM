/**
 * GET/POST /api/v1/cron/birthday-greetings
 *
 * Aniversário automatizado (VELA). Roda diariamente à meia-noite (UTC).
 *
 * Lógica:
 *   - Busca leads com status != 'lost' cujo contato faz aniversário hoje (dia/mês)
 *   - Para cada lead, localiza ou cria uma conversa dm/whatsapp
 *   - Dispara mensagem de parabéns via crm_send_whatsapp_message (MCP)
 *   - Audita SÓ se houver envio (cron sem efeito não é mutação)
 *
 * Pressupostos (MVP):
 *   - Mensagem padrão única (sem customização por lead)
 *   - Cria conversa automaticamente se não existir
 *   - Horário UTC fixo
 *   - Fail-once: se o envio falhar hoje, não retentar (MEG não retenta)
 *
 * Auth: Bearer INTERNAL_CRON_SECRET | INTERNAL_SECRET (fail-closed).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface BirthdayLead {
  lead_id: string;
  contact_id: string;
  organization_id: string;
  display_name: string | null;
}

interface SendResult {
  scanned: number;
  sent: number;
  failed: number;
  organizations_sent: number;
}

/**
 * Mensagem padrão de parabéns. Sem customização no MVP.
 */
function buildGreetingMessage(displayName: string | null): string {
  const name = displayName && displayName.trim() ? displayName : "você";
  return `Feliz aniversário, ${name}! 🎉 Que este ano seja repleto de sucesso e alegria!`;
}

/**
 * Busca leads aniversariantes (status != 'lost', birthdate hoje).
 * Retorna lista com `lead_id`, `contact_id`, `organization_id`, `display_name`.
 */
async function findBirthdayLeads(
  admin: ReturnType<typeof createAdminClient>,
): Promise<BirthdayLead[]> {
  // SQL bruto porque o Supabase PostgREST não expõe EXTRACT nativamente.
  // A query cruza crm_leads + contacts e filtra:
  //   - status != 'lost'
  //   - EXTRACT(MONTH FROM birthdate) = mês de hoje
  //   - EXTRACT(DAY FROM birthdate) = dia de hoje
  // Retorna (lead_id, contact_id, organization_id, display_name).

  const today = new Date();
  const month = String(today.getUTCMonth() + 1).padStart(2, "0"); // 01-12
  const day = String(today.getUTCDate()).padStart(2, "0"); // 01-31

  const { data, error } = await admin.rpc("find_birthday_leads" as never, {
    p_month: parseInt(month, 10),
    p_day: parseInt(day, 10),
  } as never);

  if (error) {
    throw new Error(`find_birthday_leads rpc failed: ${error.message}`);
  }

  return (data ?? []) as BirthdayLead[];
}

/**
 * Localiza ou cria uma conversa dm/whatsapp para o contact.
 * Retorna o conversation_id pronto para envio.
 */
async function getOrCreateConversation(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  contactId: string,
): Promise<string> {
  // Tenta buscar conversa existente (dm, whatsapp, ativo)
  const { data: existing } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("channel", "whatsapp")
    .eq("is_group", false)
    .maybeSingle();

  if (existing?.id) {
    return existing.id;
  }

  // Cria conversa nova se não existir
  const conversationId = randomUUID();
  const now = new Date().toISOString();
  const sessionId = `cron-birthday-${contactId}-${Date.now()}`;

  const { error: createErr } = await admin.from("conversations").insert({
    id: conversationId,
    organization_id: organizationId,
    contact_id: contactId,
    channel: "whatsapp",
    channel_session_id: sessionId,
    is_group: false,
    status: "open",
    status_changed_at: now,
    created_at: now,
    updated_at: now,
  });

  if (createErr) {
    throw new Error(
      `Failed to create conversation for contact ${contactId}: ${createErr.message}`,
    );
  }

  return conversationId;
}

/**
 * Envia mensagem de parabéns via POST ao handler sendMessageHandler.
 * Usa idempotency_key para evitar duplicação em retries do cron.
 */
async function sendBirthdayMessage(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  conversationId: string,
  contactId: string,
  message: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const year = new Date().getUTCFullYear();
  const idempotencyKey = `birthday-${contactId}-${year}`;

  try {
    // Chama o handler de envio diretamente (não via HTTP — estamos dentro do cron)
    // O handler pode ser injetado ou chamamos a MCP tool via REST.
    // Para ser consistente com o padrão de audit, usamos REST com Bearer.

    const response = await fetch(
      `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/mcp/invoke`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.INTERNAL_SECRET}`,
        },
        body: JSON.stringify({
          tool: "crm_send_whatsapp_message",
          input: {
            conversation_id: conversationId,
            body: message,
            type: "text",
            idempotency_key: idempotencyKey,
          },
        }),
      },
    );

    if (!response.ok) {
      const errBody = await response.text();
      return {
        success: false,
        error: `HTTP ${response.status}: ${errBody}`,
      };
    }

    const result = (await response.json()) as {
      message_id?: string;
      error?: string;
    };
    return {
      success: !!result.message_id,
      messageId: result.message_id,
      error: result.error,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: detail,
    };
  }
}

/**
 * Worker principal: busca aniversariantes e envia mensagens.
 */
async function sendBirthdayGreetings(
  admin: ReturnType<typeof createAdminClient>,
  requestId: string,
): Promise<SendResult> {
  const leads = await findBirthdayLeads(admin);

  if (leads.length === 0) {
    return {
      scanned: 0,
      sent: 0,
      failed: 0,
      organizations_sent: 0,
    };
  }

  let sent = 0;
  let failed = 0;
  const organizationsSent = new Set<string>();

  for (const lead of leads) {
    try {
      const conversationId = await getOrCreateConversation(
        admin,
        lead.organization_id,
        lead.contact_id,
      );

      const message = buildGreetingMessage(lead.display_name);
      const result = await sendBirthdayMessage(
        admin,
        lead.organization_id,
        conversationId,
        lead.contact_id,
        message,
      );

      if (result.success) {
        sent++;
        organizationsSent.add(lead.organization_id);
      } else {
        failed++;
        logger.warn("[birthday-greetings] send failed", {
          lead_id: lead.lead_id,
          contact_id: lead.contact_id,
          error: result.error,
          requestId,
        });
      }
    } catch (err) {
      failed++;
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("[birthday-greetings] processing failed", {
        lead_id: lead.lead_id,
        contact_id: lead.contact_id,
        error: detail,
        requestId,
      });
    }
  }

  return {
    scanned: leads.length,
    sent,
    failed,
    organizations_sent: organizationsSent.size,
  };
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let result: SendResult;
  try {
    result = await sendBirthdayGreetings(createAdminClient(), requestId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[birthday-greetings] failed", { error: detail, requestId });
    return fail("internal_error", "Failed to send birthday greetings.", 500, { requestId });
  }

  // Audita SÓ se houver envio (regra CLAUDE.md: sem efeito = sem auditoria)
  if (result.sent > 0) {
    void audit({
      action: "message.birthday_greetings_run",
      organizationId: null,
      bypassedRls: true,
      metadata: result as unknown as Record<string, unknown>,
      requestId,
    });
  }

  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
