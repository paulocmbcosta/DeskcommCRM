import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/official — estado da conexão oficial + o que colar na Meta.
 * POST /api/v1/channels/official — VALIDA a credencial e só então grava.
 *
 * O `POST` valida contra a Graph API **antes** de persistir. Gravar primeiro e
 * descobrir depois é o que faz o operador achar que conectou e só entender que não na
 * primeira mensagem que não sai — com o lead do outro lado esperando.
 *
 * O `POST` é também o caminho de VOLTA: conectar por cima de um canal oficial que
 * foi excluído RESSUSCITA a linha (`lib/channels/reactivate.ts`). Sem isso o
 * update devolvia status/credencial/número e deixava `archived_at` no lugar — e o
 * canal "conectado" ficava invisível para o webhook, para o ingest, para os
 * seletores e para o envio, todos filtrados por essa coluna.
 *
 * Ressuscitar NÃO devolve a URL de webhook antiga: a exclusão rotacionou o
 * `webhook_path_token` de propósito (é o que corta a entrega da plataforma), e a
 * volta mantém a nova. É por isso que a tela mostra o que colar na Meta depois de
 * conectar — inclusive na reconexão, onde o endereço mudou.
 *
 * O token é cifrado pelas MESMAS RPCs do resto do repo (`lib/webhooks/secrets.ts`) e
 * **nunca volta** num GET: uma vez gravado, a tela mostra que existe, não qual é.
 *
 * ─── N números por organização (a chave é o `phone_number_id`) ───────────────
 *
 * Até 2026-09-23 esta rota conhecia UM canal oficial por organização: o POST
 * procurava "o canal oficial da org" e, achando, ATUALIZAVA essa linha com o
 * número novo. Conectar um segundo número sobrescrevia o primeiro — as conversas
 * dele passavam a apontar para outro número — e o GET, com `maybeSingle()` sobre
 * duas linhas, dizia "não conectado". O resto do canal (webhook, ingestão, envio,
 * saúde, mídia) já era por número; a porta de entrada é que não era.
 *
 * Agora a linha é achada pelo NÚMERO: o mesmo `phone_number_id` é troca de
 * credencial (ou ressurreição, se foi excluído); número novo é canal novo. O
 * índice único parcial da 0165 impede o mesmo número ativo em duas linhas.
 *
 * `app_secret` é opcional (migration 0275): só para número que entrega por OUTRO
 * app da Meta, diferente do cadastrado na instalação. Conferido com a Meta por
 * `appsecret_proof` antes de gravar, como o token.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { appDaMeta, appDaMetaDoAmbiente } from "@/lib/channels/meta/app";
import { validarChaveDoApp, validateMetaCredentials } from "@/lib/channels/meta/validate-credentials";
import { reactivateChannelSession } from "@/lib/channels/reactivate";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Campo opcional do formulário: string vazia é "não informado", não erro. */
const opcional = (schema: z.ZodString) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

const conectarSchema = z.object({
  phone_number_id: z.string().trim().min(5),
  waba_id: z.string().trim().min(5),
  token: z.string().trim().min(20),
  app_secret: opcional(z.string().trim().min(16)),
  /**
   * O app que ENTREGA o webhook deste número, quando não é o app do token.
   * Com ele, a chave é conferida direto com esse app (`validarChaveDoApp`);
   * sem ele, pela prova do token (`appsecret_proof`).
   */
  app_id: opcional(z.string().trim().regex(/^\d{5,20}$/)),
});

/** Uma linha oficial, na projeção que a tela usa. */
interface LinhaOficial {
  id: string;
  meta_phone_number_id: string | null;
  meta_waba_id: string | null;
  meta_token_encrypted: unknown;
  meta_app_secret_encrypted?: unknown;
  phone_number: string | null;
  display_name: string | null;
  webhook_path_token: string;
  status: string | null;
}

/**
 * Base pública desta instalação — é o que o operador cola no dashboard da Meta.
 *
 * `env.*` e NÃO `process.env.NEXT_PUBLIC_APP_URL` direto: variáveis
 * `NEXT_PUBLIC_` são substituídas no BUILD, e a imagem genérica do self-host é
 * construída com `https://placeholder.invalid` (Dockerfile). Lendo direto do
 * `process.env`, a tela mostrava essa URL — e quem a colasse no dashboard
 * apontaria o webhook para o nada, sem erro em lugar nenhum.
 */
function publicBase(req: NextRequest): string {
  const configurada = env.NEXT_PUBLIC_APP_URL;
  const usavel = configurada && !configurada.includes("placeholder.invalid") ? configurada : null;
  return (
    usavel ?? req.headers.get("origin") ?? `${req.nextUrl.protocol}//${req.nextUrl.host}`
  );
}

/**
 * O token de verificação que esta tela pode MOSTRAR — e de onde vem o que vale.
 *
 * Isto lia `process.env.META_WEBHOOK_VERIFY_TOKEN` direto, e a migration 0257
 * tornou a leitura errada nos dois sentidos: com o App da Meta cadastrado pela
 * tela de administração, o handshake passa a conferir o token do BANCO, e esta
 * rota seguia mostrando o do `.env` (que a Meta recusaria) ou, sem `.env`,
 * "defina no servidor" para quem já tinha configurado tudo.
 *
 * O valor do banco NÃO é devolvido: ele é mostrado uma vez, na resposta da
 * action que o gera (`app/actions/settings/updateMetaApp.ts`), e aqui quem
 * responde é o admin de UM tenant, não quem administra a instalação. O do `.env`
 * continua sendo mostrado, como sempre foi — é o mesmo valor, na mesma rota.
 *
 * Por que "o que vale é igual ao do `.env`" basta para rotular a origem como
 * `ambiente`: o token em vigor (`lib/channels/meta/app.ts`) é OU o do banco OU o
 * do `.env` — o do banco só vale com o par inteiro decifrado; fora disso vale o
 * que o `.env` tiver, até pela metade. Então a igualdade só engana num caso: o
 * token do banco coincidir com o do `.env`. E o do banco ninguém escolhe — é
 * gerado pelo servidor com 32 bytes aleatórios —, então coincidir exige alguém
 * ter COPIADO o token gerado para o `.env`. Nesse caso o rótulo erra a origem,
 * mas o valor exibido é o mesmo que já está no `.env`, que esta rota sempre
 * mostrou: não sai nada que antes não saía.
 */
async function tokenDeVerificacaoParaATela(): Promise<{
  verifyToken: string | null;
  verifyTokenOrigem: "ambiente" | "instalacao" | null;
}> {
  const { verifyToken: emVigor } = await appDaMeta();
  if (!emVigor) return { verifyToken: null, verifyTokenOrigem: null };
  if (emVigor === appDaMetaDoAmbiente().verifyToken) {
    return { verifyToken: emVigor, verifyTokenOrigem: "ambiente" };
  }
  return { verifyToken: null, verifyTokenOrigem: "instalacao" };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const admin = createAdminClient();
  // Canal ARQUIVADO não conta como conectado. A linha sobrevive à exclusão como
  // âncora das FKs, e sem este filtro a tela dizia "conectado" (com a URL de
  // webhook já rotacionada, portanto morta) para um canal que o operador acabou
  // de excluir — e oferecia "Trocar credencial" onde deveria oferecer "Conectar".
  // O POST, ao contrário, PRECISA enxergar a linha arquivada: é ela que ele
  // ressuscita.
  //
  // Lista, não `maybeSingle()`: com dois números o `maybeSingle()` devolvia
  // `null` (PGRST116) e a tela dizia "não conectado" a quem tinha dois.
  const colunas =
    "id, meta_phone_number_id, meta_waba_id, meta_token_encrypted, phone_number, display_name, webhook_path_token, status";
  const consultar = (cols: string) =>
    admin
      .from("channel_sessions")
      .select(cols)
      .eq("organization_id", orgId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .order("created_at", { ascending: true });
  // A coluna da 0275 é pedida à parte: num clone sem ela, a leitura inteira
  // falharia e a tela diria "não conectado" a quem está conectado.
  let { data, error } = await queryTolerantToMissingArchived(
    () => consultar(`${colunas}, meta_app_secret_encrypted`).is(ARCHIVED_AT, null),
    () => consultar(`${colunas}, meta_app_secret_encrypted`),
  );
  if (error) {
    ({ data, error } = await queryTolerantToMissingArchived(
      () => consultar(colunas).is(ARCHIVED_AT, null),
      () => consultar(colunas),
    ));
  }
  if (error) {
    return fail("internal_error", error.message ?? "channel_session_read_failed", 500, { requestId });
  }

  const base = publicBase(req);
  const verificacao = await tokenDeVerificacaoParaATela();
  const linhas = (data ?? []) as unknown as LinhaOficial[];
  const channels = linhas.map((linha) => ({
    channel_session_id: linha.id,
    // `hasToken` em vez do token: uma vez gravado, a tela mostra que EXISTE, nunca
    // qual é. Devolver o segredo para preencher o campo seria vazá-lo a cada render.
    hasToken: Boolean(linha.meta_token_encrypted),
    /** O número entrega por um app PRÓPRIO (0275)? O segredo nunca volta. */
    hasOwnAppSecret: Boolean(linha.meta_app_secret_encrypted),
    phoneNumberId: linha.meta_phone_number_id ?? null,
    wabaId: linha.meta_waba_id ?? null,
    displayName: linha.display_name ?? null,
    phoneNumber: linha.phone_number ?? null,
    status: linha.status ?? null,
    /** O que o operador precisa colar do NOSSO lado no dashboard da Meta. */
    webhook: {
      callbackUrl: `${base}/api/v1/webhooks/meta/${linha.webhook_path_token}`,
      ...verificacao,
      // A porta para quem PODE abrir a tela da instalação — mesma regra do
      // link de `/admin/google` na Agenda. Para o admin de um tenant qualquer
      // o link seria um 404; a tela diz a ele quem procurar.
      configurarEm: authz.user.is_platform_admin && !authz.user.support ? "/admin/meta" : null,
      fields: ["messages", "message_template_status_update"],
    },
  }));

  // Os campos de topo repetem o PRIMEIRO canal: é o contrato de quem lia um
  // canal só, e continua verdadeiro para a organização que tem um só.
  const primeiro = channels[0] ?? null;
  return ok({
    connected: channels.length > 0,
    channels,
    channel_session_id: primeiro?.channel_session_id ?? null,
    hasToken: primeiro?.hasToken ?? false,
    phoneNumberId: primeiro?.phoneNumberId ?? null,
    wabaId: primeiro?.wabaId ?? null,
    displayName: primeiro?.displayName ?? null,
    phoneNumber: primeiro?.phoneNumber ?? null,
    status: primeiro?.status ?? null,
    webhook: primeiro?.webhook ?? null,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const userId = authz.user.id;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("phone_number_id, waba_id e token são obrigatórios"), 422, {
      requestId,
    });
  }
  const { phone_number_id, waba_id, token, app_secret, app_id } = parsed.data;
  if (app_id && !app_secret) {
    return fail("invalid_request", t("Informe a chave secreta do app junto com o ID do app."), 422, {
      requestId,
    });
  }

  // VALIDA ANTES DE GRAVAR — a rota não sabe com quem fala; ela pergunta se a
  // credencial presta e o canal responde. A chave secreta, colada errado, só se
  // revelaria como 401 calado na primeira mensagem do cliente — então também é
  // conferida, por um de dois caminhos:
  //   - com `app_id`: direto com o app que entrega o webhook. É o caso do token
  //     de um app e webhook de outro (medido na virada do 4063, 2026-09-24);
  //   - sem `app_id`: pela prova do token (`appsecret_proof`), que só passa
  //     quando token e chave são do mesmo app.
  const validacao = await validateMetaCredentials({
    phoneNumberId: phone_number_id,
    token,
    appSecret: app_id ? null : (app_secret ?? null),
  });
  if (!validacao.ok) {
    // A Graph diz "Invalid appsecret_proof" e não diz o que fazer: o motivo mais
    // provável é token e webhook de apps diferentes, e a saída é o ID do app.
    const motivo = /appsecret_proof/i.test(validacao.motivo)
      ? t("A chave secreta não é do app deste token. Se o webhook deste número vem de outro app da Meta, informe também o ID desse app.")
      : validacao.motivo;
    return fail("invalid_request", motivo, 422, { requestId });
  }
  if (app_id && app_secret) {
    const chave = await validarChaveDoApp({ appId: app_id, appSecret: app_secret });
    if (!chave.ok) {
      return fail(
        "invalid_request",
        `${t("A Meta não confirmou a chave secreta deste app:")} ${chave.motivo}`,
        422,
        { requestId },
      );
    }
  }

  const admin = createAdminClient();
  const cifrado = await encryptWebhookSecret(admin, token);
  if (!cifrado) {
    // Sem a GUC de cifra configurada, gravar o token em claro seria pior que
    // recusar. O operador precisa saber que falta uma configuração de servidor.
    return fail(
      "invalid_request",
      t("cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado"),
      422,
      { requestId },
    );
  }
  const segredoCifrado = app_secret ? await encryptWebhookSecret(admin, app_secret) : null;
  if (app_secret && !segredoCifrado) {
    return fail(
      "invalid_request",
      t("cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado"),
      422,
      { requestId },
    );
  }

  // A busca é pelo NÚMERO: o mesmo `phone_number_id` é troca de credencial;
  // número novo é canal novo (ver o cabeçalho). Buscar "o canal oficial da org"
  // era o que fazia o segundo número sobrescrever o primeiro.
  //
  // NÃO filtra `archived_at`: um canal oficial excluído é exatamente o que este
  // POST precisa achar para trazer de volta. Ignorá-lo criaria uma segunda linha
  // para o mesmo número — e a velha continuaria segurando o par (org, número)
  // na trava da 0106. Mais recente primeiro: se o número foi conectado,
  // excluído e conectado de novo, é a última que volta.
  const buscarExistente = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", orgId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .eq("meta_phone_number_id", phone_number_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
  const { data: existenteRaw } = await queryTolerantToMissingArchived(
    () => buscarExistente(`id, ${ARCHIVED_AT}`),
    () => buscarExistente("id"),
  );
  const existente = existenteRaw as { id: string; archived_at?: string | null } | null;

  const linha = {
    organization_id: orgId,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: phone_number_id,
    meta_waba_id: waba_id,
    meta_token_encrypted: cifrado,
    phone_number: validacao.displayPhoneNumber ? `+${validacao.displayPhoneNumber.replace(/\D/g, "")}` : null,
    display_name: validacao.verifiedName ?? "Canal oficial",
    status: "WORKING",
    // Só entra no patch quando foi informado: trocar o token de um número que
    // entrega por app próprio não pode apagar o segredo desse app.
    ...(segredoCifrado ? { meta_app_secret_encrypted: segredoCifrado } : {}),
  };

  // `update` quando já existe em vez de upsert: a trava única de (org,
  // phone_number) não serve de árbitro de `ON CONFLICT` aqui. Era DEFERRABLE
  // (medido ao criar a sessão de teste da Fase 3b, e o Postgres recusa
  // constraint deferível na inferência); a migration 0107 a trocou por um índice
  // único PARCIAL (`where archived_at is null`), que só seria inferível se a
  // cláusula repetisse o predicado — e o cliente do PostgREST não expõe isso.
  // Mudou a razão, não a escolha.
  //
  // O update passa por `reactivateChannelSession` porque reconectar é
  // ressuscitar: o mesmo patch que devolve status, credencial e número tem que
  // devolver a linha à vida, ou o canal fica "conectado" na tela e excluído para
  // todo o resto do sistema. Para o canal que já estava ativo é um no-op — e a
  // auditoria de volta sai de lá, junto da ressurreição, não daqui.
  const { error } = existente
    ? await reactivateChannelSession(
        admin,
        {
          organizationId: orgId,
          channelSessionId: existente.id,
          archivedAt: existente.archived_at ?? null,
        },
        linha,
        {
          userId: userId,
          requestId,
          metadata: { provider: CHANNEL_PROVIDER_META, phone_number: linha.phone_number },
        },
      )
    : await admin.from("channel_sessions").insert({
        ...linha,
        webhook_secret_encrypted: cifrado,
        metadata: metadataInicialDoCanal(),
      });

  if (error) {
    // O índice único parcial da 0165: o número já está ativo noutra organização
    // desta instalação. Dizer isso, e não um 500 com o nome do índice.
    if ((error as { code?: string }).code === "23505") {
      return fail(
        "state_conflict",
        t("Este número já está conectado em outra organização desta instalação."),
        409,
        { requestId },
      );
    }
    return fail("internal_error", error.message ?? "channel_session_write_failed", 500, {
      requestId,
    });
  }

  // Número novo é canal novo e merece a sua linha na trilha. A troca de
  // credencial de um canal ativo também; a ressurreição já foi auditada por
  // `reactivateChannelSession`, junto do ato.
  if (!existente || !existente.archived_at) {
    void audit({
      action: existente ? "channel.reconnected" : "channel.connected",
      actorUserId: userId,
      organizationId: orgId,
      resourceType: "channel_session",
      resourceId: existente?.id ?? null,
      requestId,
      metadata: {
        provider: CHANNEL_PROVIDER_META,
        phone_number: linha.phone_number,
        app_secret_proprio: Boolean(segredoCifrado),
        app_do_webhook: app_id ?? null,
      },
    });
  }

  return ok({
    connected: true,
    displayName: linha.display_name,
    phoneNumber: linha.phone_number,
  });
}
