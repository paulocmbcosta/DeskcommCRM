import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/templates — o espelho local + o CONTRATO derivado de cada um.
 * POST /api/v1/channels/templates — força um sync com a Graph API.
 *
 * O contrato vai derivado no payload, e não guardado no banco, de propósito: guardar
 * o derivado criaria a segunda fonte da verdade que esta fase inteira existe para
 * eliminar. A tela e o montador de envio chamam a MESMA `deriveTemplateContract`.
 *
 * Nenhum campo aqui é "quantidade de parâmetros". O número é consequência dos slots;
 * se algum dia aparecer um campo editável com esse nome, o desenho vazou.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { resolveMetaCreds } from "@/lib/channels/meta/credentials";
import { metaSessionsForOrg } from "@/lib/channels/meta/session";
import { normalizeRejectedReason } from "@/lib/channels/meta/webhook";
import { deriveTemplateContract, describeAddress } from "@/lib/channels/meta/template-contract";
import { syncTemplates, type SyncCounts } from "@/lib/channels/meta/template-sync";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Um template pronto para a tela: o que a Meta diz + o contrato derivado. */
export interface TemplateView {
  /** A conta (WABA) dona do modelo — com dois números de contas diferentes, a tela agrupa por ela. */
  wabaId: string;
  name: string;
  language: string;
  status: string;
  category: string | null;
  rejectedReason: string | null;
  qualityScore: string | null;
  parameterFormat: string;
  contractHash: string;
  syncedAt: string;
  slots: Array<{
    key: string;
    expects: string;
    onde: string;
  }>;
  /**
   * Texto de cada componente que carrega parâmetro, INTEIRO e uma vez só.
   * Antes a tela mostrava o corpo repetido a cada slot, cada linha destacando o
   * seu e deixando o vizinho cru — correto e ilegível. A UI marca os `{{n}}`.
   */
  previews: Array<{ onde: string; text: string }>;
  /** A definição crua — de onde sai o texto que vai no corpo do envio. */
  components: unknown[];
}

/** Textos com placeholder, achatados (inclui os de dentro de card de carrossel). */
function textPreviews(components: unknown): Array<{ onde: string; text: string }> {
  const out: Array<{ onde: string; text: string }> = [];
  const visita = (lista: unknown, prefixo: string) => {
    if (!Array.isArray(lista)) return;
    for (const c of lista as Array<Record<string, unknown>>) {
      const tipo = String(c.type ?? "").toUpperCase();
      if (Array.isArray(c.cards)) {
        (c.cards as Array<Record<string, unknown>>).forEach((card, i) =>
          visita(card.components, `card ${i + 1} › `),
        );
        continue;
      }
      const texto = typeof c.text === "string" ? c.text : "";
      if (!texto.includes("{{")) continue;
      out.push({ onde: `${prefixo}${tipo === "HEADER" ? "cabeçalho" : "corpo"}`, text: texto });
    }
  };
  visita(components, "");
  return out;
}

type OrgGate =
  | { autorizado: true; orgId: string }
  | { autorizado: false; resposta: NextResponse };

async function orgOrFail(requestId: string): Promise<OrgGate> {
  const authz = await requireRole("admin", { requestId, resource: "channels_templates" });
  if (!authz.ok) return { autorizado: false, resposta: authz.response };
  return { autorizado: true, orgId: authz.org.orgId };
}

export async function GET(): Promise<NextResponse> {
  const requestId = randomUUID();
  const r = await orgOrFail(requestId);
  if (!r.autorizado) return r.resposta;

  const sessoes = await metaSessionsForOrg(r.orgId);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("meta_templates")
    .select(
      "waba_id, name, language, status, category, rejected_reason, quality_score, parameter_format, contract_hash, components, synced_at",
    )
    .eq("organization_id", r.orgId)
    .order("status")
    .order("name");

  if (error) return fail("internal_error", error.message, 500, { requestId });

  const templates: TemplateView[] = (data ?? []).map((row) => {
    const contrato = deriveTemplateContract({
      name: row.name,
      language: row.language,
      parameter_format: row.parameter_format,
      components: row.components as never,
    });
    return {
      wabaId: row.waba_id,
      name: row.name,
      language: row.language,
      status: row.status,
      category: row.category,
      // Normaliza na LEITURA também: o "NONE" da Meta pode ter sido gravado por
      // uma versão anterior ao conserto, e um clone atualizado ainda o carrega.
      rejectedReason: normalizeRejectedReason(row.rejected_reason),
      qualityScore: row.quality_score,
      parameterFormat: contrato.parameterFormat,
      contractHash: row.contract_hash,
      syncedAt: row.synced_at,
      slots: contrato.slots.map((s) => ({
        key: s.key,
        expects: s.expects,
        onde: describeAddress(s.address),
      })),
      previews: textPreviews(row.components),
      // A DEFINIÇÃO crua, como a rota do canal intermediado já devolve.
      //
      // `previews` não serve para isto: ele filtra por `{{` (só interessa
      // mostrar o que tem variável), então um modelo SEM variável sai com a
      // lista vazia — e são exatamente esses que o operador consegue disparar
      // sem preencher nada. O seletor da janela fechada monta o corpo da
      // mensagem a partir daqui; sem o campo, ele caía no NOME TÉCNICO do
      // modelo e era isso que o cliente recebia.
      components: (row.components as unknown[]) ?? [],
    };
  });

  return ok({
    // `null` aqui não é "erro": é o estado de quem não tem canal oficial ATIVO —
    // nunca conectou, ou conectou e excluiu —, e a tela precisa distingui-lo de
    // "conectado, porém sem template".
    waba: sessoes[0]?.wabaId ?? null,
    /**
     * Cada conta (WABA) com os números oficiais dela. Um número por conta é o
     * caso comum; dois números da MESMA conta dividem os modelos.
     */
    contas: contasDasSessoes(sessoes),
    templates,
  });
}

export async function POST(_req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const r = await orgOrFail(requestId);
  if (!r.autorizado) return r.resposta;

  // TODAS as contas oficiais da organização, uma sincronização por conta (WABA).
  // Espelhava só a primeira: com um segundo número de outra conta, os modelos
  // dele nunca chegavam ao espelho, e o número não conseguia falar primeiro.
  const contas = contasDasSessoes(await metaSessionsForOrg(r.orgId));
  if (contas.length === 0) {
    return fail("invalid_request", "no_meta_channel", 400, { requestId });
  }

  const total: SyncCounts = { inserted: 0, updated: 0, unchanged: 0, disabled: 0 };
  const falhas: string[] = [];
  let semCredencial = 0;

  for (const conta of contas) {
    // A credencial vem da SESSÃO que o operador conectou na tela, com o ambiente só
    // como RESERVA — a mesma porta que `send`, `checkHealth` e `fetchInboundMedia` já
    // usam. Antes disto este 400 olhava só `META_SYSTEM_USER_TOKEN`: numa instalação que
    // conectou o número pela TELA, "Sincronizar modelos" respondia
    // `400 missing_meta_token` a quem tinha credencial salva e visível na própria tela.
    //
    // A ORDEM dos desfechos NÃO muda: sem canal oficial a resposta continua
    // `no_meta_channel`; com canal e sem credencial nenhuma (nem na sessão, nem no
    // ambiente) continua `missing_meta_token` 400 — o que muda é só de ONDE a
    // credencial sai quando existe.
    const creds = await resolveMetaCreds(createAdminClient(), {
      organizationId: r.orgId,
      phoneNumberId: conta.phoneNumberId ?? "",
    });
    if (!creds) {
      semCredencial += 1;
      continue;
    }

    try {
      const counts = await syncTemplates({
        organizationId: r.orgId,
        wabaId: conta.wabaId,
        token: creds.token,
        graphVersion: creds.graphVersion,
      });
      total.inserted += counts.inserted;
      total.updated += counts.updated;
      total.unchanged += counts.unchanged;
      total.disabled += counts.disabled;
    } catch (err) {
      // Uma conta que falha não impede a outra de sincronizar — e a mensagem diz
      // QUAL conta falhou, senão o operador troca o token do número errado.
      const motivo = err instanceof Error ? err.message : "sync_failed";
      falhas.push(contas.length > 1 ? `${conta.rotulo}: ${motivo}` : motivo);
    }
  }

  if (semCredencial === contas.length) {
    return fail("invalid_request", "missing_meta_token", 400, { requestId });
  }
  if (falhas.length > 0) {
    // A falha da Graph API vira mensagem legível na tela, não 500 mudo — o
    // operador precisa saber se é token vencido, WABA errada ou rede.
    return fail("internal_error", falhas.join(" · "), 502, { requestId });
  }
  return ok(total);
}

/** Uma conta (WABA) oficial, com o número que a representa e todos os dela. */
interface ContaOficial {
  wabaId: string;
  /** O número cuja credencial sincroniza a conta — o mais antigo dela. */
  phoneNumberId: string | null;
  /** Como a tela e a mensagem de erro nomeiam a conta. */
  rotulo: string;
  numeros: Array<{ phoneNumber: string | null; displayName: string | null }>;
}

/** Agrupa as sessões por conta. Sessão sem WABA não tem modelo a espelhar. */
function contasDasSessoes(sessoes: Awaited<ReturnType<typeof metaSessionsForOrg>>): ContaOficial[] {
  const porConta = new Map<string, ContaOficial>();
  for (const s of sessoes) {
    if (!s.wabaId) continue;
    const numero = { phoneNumber: s.phoneNumber ?? null, displayName: s.displayName ?? null };
    const conta = porConta.get(s.wabaId);
    if (conta) {
      conta.numeros.push(numero);
      continue;
    }
    porConta.set(s.wabaId, {
      wabaId: s.wabaId,
      phoneNumberId: s.phoneNumberId,
      rotulo: s.phoneNumber ?? s.displayName ?? s.wabaId,
      numeros: [numero],
    });
  }
  return [...porConta.values()];
}
