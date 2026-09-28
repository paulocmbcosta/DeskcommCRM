/**
 * POST /api/v1/telefonia/falas/previa — gera a PRÉVIA de uma fala para a tela
 * ouvir antes de salvar (gerente ou admin).
 *
 * Desenho da fase 2, D15 e §4 (passo 1). É a ÚNICA rota que faz a ElevenLabs
 * sintetizar, e ela não muda nada nas ligações:
 *  - mesmo texto, mesma voz e mesmo modelo que já têm objeto no Storage →
 *    devolve o objeto, sem custo e sem gastar cota;
 *  - senão, gasta uma da cota da organização da SESSÃO (30 por hora), chama a
 *    ElevenLabs uma vez e grava `<org>/<hash>.ulaw`;
 *  - nenhuma linha de `phone_prompts` muda — isso é o "Salvar e usar" (as rotas da
 *    fala geral, do menu e do aviso), que recebe de volta o `hash` desta resposta.
 *
 * Gerente, e não só admin: o aviso de instabilidade (gerente ou admin, §7) também
 * passa pela prévia. O corpo traz SÓ o texto — voz, modelo, organização e caminho
 * saem do servidor.
 *
 * O texto é conferido pela régua ÚNICA (`textoDaFalaValido`) antes de tudo, com
 * mensagem PRÓPRIA: a de `texto_recusado` diz que a ElevenLabs recusou, e quem
 * recusou um texto vazio, longo demais ou com NUL fomos nós — sem ir a ela.
 *
 * A cota estourada volta 429 (`limite_de_previas`) com `Retry-After` e
 * `X-RateLimit-*`: é limite NOSSO, e a doutrina da API é essa. O `Retry-After`
 * (até uma hora) passa dos 10 s em que o `apiClient` ainda espera, então ele lança
 * na hora em vez de prender o botão (lib/api/client.ts). As falhas da ElevenLabs
 * seguem 422/502 (`STATUS_DA_FALHA`).
 *
 * Auditoria (`phone.prompt_previewed`): toda síntese PAGA — a que ficou guardada e
 * a que a ElevenLabs cobrou mas o Storage não guardou (`paga: true`, com
 * `guardada: false` no metadata, e a tela avisa que a fala foi gerada mas não
 * guardada). A reaproveitada não fez nada e não audita. Nunca o texto nem o áudio.
 *
 * O áudio vai em base64 no JSON: 1000 caracteres de fala cabem em poucas centenas
 * de KB, e uma ida só entrega o hash e o som.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { hashDaFala, textoDaFalaValido } from "@/lib/telefonia/falas";
import { gerarPrevia } from "@/lib/telefonia/previa";
import {
  STATUS_DA_FALHA,
  armazemDaInstalacao,
  consumirCotaDePrevia,
  contextoDeFala,
  sintetizadorDaInstalacao,
  type CotaDePrevia,
} from "@/lib/telefonia/servico-de-falas";
import {
  MENSAGEM_DA_FALHA_DA_FALA,
  MENSAGEM_DO_TEXTO_INVALIDO,
  type PreviaNaResposta,
} from "@/lib/telefonia/vocabulario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Só a forma. O conteúdo do texto é da régua única (`textoDaFalaValido`), com a mensagem dela. */
const previaSchema = z.object({ texto: z.string() }).strict();

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "telefonia_falas" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = previaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });
  if (!textoDaFalaValido(parsed.data.texto)) {
    return fail("validation_failed", t(MENSAGEM_DO_TEXTO_INVALIDO), 422, { requestId });
  }
  const texto = parsed.data.texto.trim();

  const org = authz.org.orgId;
  const { chave, voz } = await contextoDeFala(getRequestPool(), org);
  // Num objeto, e não num `let`: o TypeScript não enxerga a atribuição feita dentro do callback.
  const medida: { cota: CotaDePrevia | null } = { cota: null };
  const r = await gerarPrevia({
    armazem: armazemDaInstalacao(),
    sintetizar: sintetizadorDaInstalacao(),
    consumirCota: async () => {
      medida.cota = await consumirCotaDePrevia(org);
      return medida.cota.permitida;
    },
    organizationId: org,
    texto,
    chave,
    voz,
  });

  const cota = medida.cota;
  const headers: Record<string, string> = {};
  if (cota) {
    headers["X-RateLimit-Limit"] = String(cota.limite);
    headers["X-RateLimit-Remaining"] = String(cota.restantes);
  }

  if (!r.ok) {
    if (r.motivo === "limite_de_previas") headers["Retry-After"] = String(cota?.reabreEmS ?? 3600);
    if (r.paga) {
      // A ElevenLabs cobrou e o áudio não ficou guardado: o gasto entra na trilha,
      // e a pessoa fica sabendo que gerar de novo vai custar de novo.
      void audit({
        action: "phone.prompt_previewed",
        actorUserId: authz.user.id,
        organizationId: org,
        resourceType: "phone_prompt",
        resourceId: null,
        metadata: {
          hash: voz ? hashDaFala(texto, voz.voiceId, voz.modelId) : null,
          caracteres: texto.length,
          guardada: false,
          motivo: r.motivo,
        },
        requestId,
      });
      return fail(
        r.motivo,
        t("A fala foi gerada na ElevenLabs, mas não foi possível guardá-la. Tente de novo em instantes."),
        STATUS_DA_FALHA[r.motivo],
        { requestId, headers, details: { paga: true } },
      );
    }
    return fail(r.motivo, t(MENSAGEM_DA_FALHA_DA_FALA[r.motivo]), STATUS_DA_FALHA[r.motivo], { requestId, headers });
  }

  if (!r.reaproveitada) {
    void audit({
      action: "phone.prompt_previewed",
      actorUserId: authz.user.id,
      organizationId: org,
      resourceType: "phone_prompt",
      resourceId: null,
      metadata: { hash: r.hash, caracteres: texto.length, duracao_ms: r.duracaoMs, guardada: true },
      requestId,
    });
  }
  const corpo: PreviaNaResposta = {
    hash: r.hash,
    duracao_ms: r.duracaoMs,
    reaproveitada: r.reaproveitada,
    audio_base64: Buffer.from(r.audio).toString("base64"),
  };
  return ok(corpo, { requestId, headers });
}
