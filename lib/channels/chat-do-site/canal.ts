/**
 * A LINHA do chat do site em `channel_sessions` — criar, listar, editar, excluir.
 *
 * As rotas de administração (`app/api/v1/channels/site-chat/`) são cascas: quem
 * sabe quais colunas este canal usa é este arquivo, pelo mesmo motivo de
 * `../connect.ts` para o canal intermediado — coluna de provider fora de
 * `lib/channels/` o `lint:channels` reprova.
 *
 * ─── Por que o admin client, e o que ele obriga ─────────────────────────────
 *
 * A policy de escrita de `channel_sessions` exige papel, e as rotas já o cobram
 * (`requireRole("admin")`) antes de chegar aqui. O client de service role
 * bypassa RLS, então TODA consulta abaixo filtra `organization_id` à mão, com o
 * valor que veio da sessão autenticada — nunca do corpo (CLAUDE.md,
 * multi-tenancy). A única exceção é `canalPelaChave`, e ela está explicada lá.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";

import { CHANNEL_PROVIDER_SITE_WIDGET } from "../capabilities";

import { CONFIG_PADRAO_DO_WIDGET, lerConfig, type ConfigDoWidget } from "./config";
import { gerarChaveDoWidget } from "./identidade";

/** Onde o widget foi visto pela última vez — a prova de que o snippet está no ar. */
export interface SinalDoWidget {
  /** ISO-8601. */
  em: string;
  /** `hostname` do site que carregou o widget. `null` quando o navegador não disse. */
  site: string | null;
}

export interface CanalDoSite {
  id: string;
  nome: string;
  /** A chave PÚBLICA — vai no snippet. */
  chave: string;
  config: ConfigDoWidget;
  criadoEm: string;
  ultimoSinal: SinalDoWidget | null;
}

const COLUNAS =
  "id, display_name, site_widget_key, site_widget_config, site_widget_seen_at, site_widget_seen_host, created_at";

interface Linha {
  id: string;
  display_name: string | null;
  site_widget_key: string | null;
  site_widget_config: unknown;
  site_widget_seen_at: string | null;
  site_widget_seen_host: string | null;
  created_at: string;
}

function lerSinal(l: { site_widget_seen_at: string | null; site_widget_seen_host: string | null }): SinalDoWidget | null {
  return l.site_widget_seen_at ? { em: l.site_widget_seen_at, site: l.site_widget_seen_host } : null;
}

function paraCanal(l: Linha): CanalDoSite | null {
  // Linha do provider sem chave não existe (o CHECK do banco recusa); o `null`
  // aqui é para o tipo, não para um caso esperado.
  if (!l.site_widget_key) return null;
  return {
    id: l.id,
    nome: l.display_name?.trim() || "Chat do site",
    chave: l.site_widget_key,
    config: lerConfig(l.site_widget_config),
    criadoEm: l.created_at,
    ultimoSinal: lerSinal(l),
  };
}

export async function listarCanaisDoSite(
  admin: SupabaseClient,
  organizationId: string,
): Promise<CanalDoSite[]> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_SITE_WIDGET)
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`site_chat_list_failed: ${error.message}`);
  return ((data ?? []) as Linha[]).flatMap((l) => paraCanal(l) ?? []);
}

export async function buscarCanalDoSite(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<CanalDoSite | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_SITE_WIDGET)
    .eq("id", id)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`site_chat_read_failed: ${error.message}`);
  return data ? paraCanal(data as Linha) : null;
}

/** Quantos widgets uma organização pode ter. Teto de sanidade, não de plano. */
export const MAXIMO_DE_CANAIS_DO_SITE = 10;

export async function criarCanalDoSite(
  admin: SupabaseClient,
  input: { organizationId: string; nome: string; config?: ConfigDoWidget; criadoPor: string | null },
): Promise<CanalDoSite> {
  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: input.organizationId,
      provider: CHANNEL_PROVIDER_SITE_WIDGET,
      site_widget_key: gerarChaveDoWidget(),
      site_widget_config: input.config ?? CONFIG_PADRAO_DO_WIDGET,
      display_name: input.nome,
      // Não há conexão a estabelecer: o transporte é o nosso banco. Nasce
      // `WORKING` porque é o que o handler de envio exige para não enfileirar —
      // e porque é verdade.
      status: "WORKING",
      // `webhook_secret_encrypted` é NOT NULL na tabela e não significa nada para
      // este canal (nenhum webhook chega). Mesmo placeholder que a linha de voz
      // usa; `webhook_path_token` cai no DEFAULT do banco.
      webhook_secret_encrypted: Buffer.from([0]),
      // Nasce FECHADO para a IA, como todo canal criado pelo produto: o robô só
      // fala com o público depois de uma abertura explícita na tela.
      metadata: metadataInicialDoCanal(),
      created_by: input.criadoPor,
    })
    .select(COLUNAS)
    .single();
  if (error || !data) throw new Error(`site_chat_create_failed: ${error?.message ?? "sem linha"}`);
  const canal = paraCanal(data as Linha);
  if (!canal) throw new Error("site_chat_create_failed: linha criada sem chave");
  return canal;
}

export async function atualizarCanalDoSite(
  admin: SupabaseClient,
  input: { organizationId: string; id: string; nome?: string; config?: ConfigDoWidget },
): Promise<CanalDoSite | null> {
  const patch: Record<string, unknown> = {};
  if (input.nome !== undefined) patch.display_name = input.nome;
  if (input.config !== undefined) patch.site_widget_config = input.config;
  if (Object.keys(patch).length === 0) {
    return buscarCanalDoSite(admin, input.organizationId, input.id);
  }

  const { data, error } = await admin
    .from("channel_sessions")
    .update(patch)
    .eq("organization_id", input.organizationId)
    .eq("provider", CHANNEL_PROVIDER_SITE_WIDGET)
    .eq("id", input.id)
    .is("archived_at", null)
    .select(COLUNAS)
    .maybeSingle();
  if (error) throw new Error(`site_chat_update_failed: ${error.message}`);
  return data ? paraCanal(data as Linha) : null;
}

/** O que a rota PÚBLICA precisa saber de um widget, e nada além. */
export interface CanalPublico {
  id: string;
  organizationId: string;
  nome: string;
  config: ConfigDoWidget;
  ultimoSinal: SinalDoWidget | null;
}

/**
 * Chave pública → canal. É daqui que a rota pública tira a ORGANIZAÇÃO.
 *
 * ─── A única consulta deste diretório sem `organization_id` no filtro ───────
 *
 * E não por descuido: a chave é justamente o que DIZ qual é a organização — não
 * há outra fonte confiável num pedido anônimo vindo do site de um terceiro. O
 * que torna isso seguro é a mesma propriedade que o cabeçalho de
 * `tests/unit/canal-consulta-por-organizacao.test.ts` exige de quem resolve sem
 * escopo: a coluna é ÚNICA POR CONSTRUÇÃO (`channel_sessions_site_widget_key_unique`,
 * sem recorte de arquivados), então `maybeSingle()` nunca vê duas linhas — o
 * modo de falha da issue #236 não tem como acontecer. O teste prende o índice.
 *
 * Arquivado = inexistente: o snippet esquecido num site some em silêncio, que
 * é o que o dono pediu ao excluir o canal.
 */
export async function canalPelaChave(
  admin: SupabaseClient,
  chave: string,
): Promise<CanalPublico | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, display_name, site_widget_config, site_widget_seen_at, site_widget_seen_host")
    .eq("site_widget_key", chave)
    .eq("provider", CHANNEL_PROVIDER_SITE_WIDGET)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`site_chat_lookup_failed: ${error.message}`);
  if (!data) return null;
  const l = data as {
    id: string;
    organization_id: string;
    display_name: string | null;
    site_widget_config: unknown;
    site_widget_seen_at: string | null;
    site_widget_seen_host: string | null;
  };
  return {
    id: l.id,
    organizationId: l.organization_id,
    nome: l.display_name?.trim() || "Chat do site",
    config: lerConfig(l.site_widget_config),
    ultimoSinal: lerSinal(l),
  };
}

/** De quanto em quanto tempo o sinal é regravado. */
const INTERVALO_DO_SINAL_MS = 5 * 60 * 1000;

/**
 * Registra que o widget foi carregado num site — a prova, para o dono, de que o
 * snippet que ele colou está no ar (invariante 6: configuração tem superfície,
 * e o que falta aparece). Sem isto a tela de Conexões só saberia dizer "criado",
 * nunca "instalado", e o defeito mais comum desta feature — colar o snippet no
 * lugar errado — seria invisível até alguém reclamar que ninguém escreve.
 *
 * No máximo uma escrita a cada cinco minutos por canal: a rota que chama isto é
 * a de configuração, que todo visitante de todo site bate ao carregar a página.
 *
 * Best-effort, e sem lançar: é telemetria de instalação, não pode derrubar a
 * entrega da configuração.
 *
 * Colunas PRÓPRIAS, não uma chave de `metadata`: `metadata` carrega o gate da IA
 * do canal, e um ler-mesclar-gravar aqui disputaria corrida com a RPC que abre e
 * fecha o robô ao público (racional completo na migration 0272).
 */
export async function registrarSinalDoWidget(
  admin: SupabaseClient,
  canal: CanalPublico,
  site: string | null,
  agora: Date = new Date(),
): Promise<void> {
  const ultimo = canal.ultimoSinal;
  if (ultimo && ultimo.site === site) {
    const idade = agora.getTime() - new Date(ultimo.em).getTime();
    if (Number.isFinite(idade) && idade < INTERVALO_DO_SINAL_MS) return;
  }
  try {
    await admin
      .from("channel_sessions")
      .update({ site_widget_seen_at: agora.toISOString(), site_widget_seen_host: site })
      .eq("organization_id", canal.organizationId)
      .eq("id", canal.id);
  } catch {
    /* telemetria de instalação: nunca derruba a rota de configuração */
  }
}
