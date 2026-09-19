/**
 * OS MODELOS QUE ESTA CONEXÃO PODE DISPARAR — a resposta única, para qualquer canal.
 *
 * ─── O defeito que isto fecha ───────────────────────────────────────────────
 *
 * Havia duas rotas servindo a mesma pergunta, e elas discordavam em três eixos
 * ao mesmo tempo. Medido em 2026-09-19:
 *
 *   | | `/channels/templates` | `/channels/partner/templates` |
 *   |---|---|---|
 *   | autorização | `requireRole("admin")` | qualquer usuário logado |
 *   | devolve `slots` | sim | **não** |
 *   | devolve `contract_hash` | sim | **não** |
 *
 * As duas consequências são silenciosas, que é o que as torna caras:
 *
 *   - Um `agent` — o papel de QUEM ATENDE — recebia 403 no canal oficial, e o
 *     seletor de modelos do inbox mostrava "Nenhum modelo aprovado ainda". A
 *     frase é falsa: os modelos existem, ele é que não podia lê-los. Quem
 *     atende é justamente quem precisa mandar modelo quando a janela fecha.
 *   - No canal intermediado, `slots` nunca vinha, então `tpl.slots?.length` era
 *     sempre `undefined` e o aviso "este modelo pede N parâmetros" não aparecia
 *     — exatamente onde ele decide se o envio vai funcionar.
 *
 * ─── Por que aqui, e não numa rota ──────────────────────────────────────────
 *
 * Porque responder exige saber QUAL canal é, e o invariante 1 da doutrina
 * (`docs/doctrine/restricao-de-canal.md`) proíbe isso fora de `lib/channels/`.
 * A tela recebe `exigeModelo` — um fato sobre o que ela pode oferecer — e nunca
 * o nome de quem impôs a regra. Canal novo entra na matriz de capabilities e
 * nenhuma linha de tela muda.
 *
 * ─── A chave do valor vem PRONTA ────────────────────────────────────────────
 *
 * Cada slot já carrega `chave`, montada por `slotKey` — a MESMA função que o
 * montador do payload usa. A tela nunca a constrói: "chave montada de dois
 * jeitos diferentes é o mismatch voltando pela porta dos fundos"
 * (`build-components.ts`). Ela apenas devolve o que preencheu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { capabilitiesOf } from "./capabilities";
import { slotKey } from "./meta/build-components";
import { deriveTemplateContract, describeAddress } from "./meta/template-contract";
import type { ChannelProvider } from "./types";

/** Um slot pronto para virar campo de formulário. */
export interface SlotParaTela {
  /** A chave de `template_values`. Vem montada; a tela não a constrói. */
  chave: string;
  /** `1`, `2` ou `customer_name` — o que o operador vê escrito no modelo. */
  key: string;
  expects: string;
  /** "corpo", "cabeçalho", "botão 2 (url)", "card 1 › corpo". */
  onde: string;
  /** Texto ao redor do placeholder: é o que torna o campo preenchível. */
  contextoAntes: string;
  contextoDepois: string;
}

export interface ModeloParaEnvio {
  name: string;
  language: string;
  status: string;
  category: string | null;
  /** A definição crua — de onde sai o texto que a conversa mostra depois. */
  components: unknown[];
  slots: SlotParaTela[];
}

export interface ModelosDaConexao {
  /**
   * `true` quando texto livre NÃO sai por este canal fora da janela de 24h — ou
   * seja, quando modelo aprovado é o único caminho para falar primeiro.
   *
   * É a tradução NEUTRA de `!caps.freeformOutsideWindow`. A tela decide o modo
   * com este booleano e nunca pergunta quem é o provider.
   */
  exigeModelo: boolean;
  modelos: ModeloParaEnvio[];
}

interface LinhaDeModelo {
  name: string;
  language: string;
  status: string;
  category: string | null;
  parameter_format: string | null;
  components: unknown;
}

/** `APPROVED` é o único estado que a plataforma entrega. Ver `template-binding.ts`. */
const APROVADO = "APPROVED";

/**
 * Os modelos aprovados desta conexão, com o contrato de parâmetros derivado.
 *
 * `soAprovados` existe porque as duas telas querem coisas diferentes e as duas
 * estão certas: quem vai DISPARAR agora só pode ver o que a plataforma entrega
 * (oferecer um `PENDING` é oferecer um clique que falha), enquanto quem
 * administra precisa ver os reprovados para saber por quê.
 *
 * @throws quando a conexão não é da organização. Devolver lista vazia faria
 *   "canal de outra org" e "canal sem modelo" contarem a mesma história, e só a
 *   primeira é um defeito que alguém precisa ver.
 */
export async function modelosParaEnvio(
  db: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
  opcoes: { soAprovados?: boolean } = {},
): Promise<ModelosDaConexao> {
  const { data: sessao, error: erroSessao } = await db
    .from("channel_sessions")
    .select("id, provider")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .maybeSingle();

  if (erroSessao) throw new Error(`sessao_ilegivel: ${erroSessao.message}`);
  if (!sessao) throw new Error("session_not_found");

  const caps = capabilitiesOf((sessao as { provider: string }).provider as ChannelProvider);
  const exigeModelo = !caps.freeformOutsideWindow;

  // Canal de texto livre não tem definição aprovada para listar — e um seletor
  // ali ofereceria solução para um problema que este canal não tem
  // (`templates-fonte.ts`). Sair antes também evita uma consulta inútil.
  if (!exigeModelo) return { exigeModelo: false, modelos: [] };

  const colunas = "name, language, status, category, parameter_format, components";
  const porSessao = () =>
    db
      .from("meta_templates")
      .select(colunas)
      .eq("organization_id", organizationId)
      .eq("channel_session_id", channelSessionId)
      .order("name");

  let { data, error } = await porSessao();

  // A coluna `channel_session_id` entrou na 0144. Num clone que subiu a imagem
  // antes do baseline, filtrar por ela devolve 42703 → lista vazia → "nenhum
  // modelo aprovado", convidando o operador a criar um modelo que já existe.
  // Sem a coluna não há duas conexões a distinguir, e a lista sem filtro é a
  // lista exata — mesmo raciocínio de `lib/channels/archived.ts`.
  if (error?.code === "42703") {
    ({ data, error } = await db
      .from("meta_templates")
      .select(colunas)
      .eq("organization_id", organizationId)
      .order("name"));
  }
  if (error) throw new Error(`modelos_ilegiveis: ${error.message}`);

  const linhas = (data ?? []) as unknown as LinhaDeModelo[];
  const visiveis = opcoes.soAprovados === false
    ? linhas
    : linhas.filter((l) => (l.status ?? "").toUpperCase() === APROVADO);

  return {
    exigeModelo: true,
    modelos: visiveis.map((linha) => {
      const contrato = deriveTemplateContract({
        name: linha.name,
        language: linha.language,
        parameter_format: linha.parameter_format ?? undefined,
        components: linha.components as Parameters<typeof deriveTemplateContract>[0]["components"],
      });
      return {
        name: linha.name,
        language: linha.language,
        status: linha.status,
        category: linha.category ?? null,
        components: (linha.components as unknown[]) ?? [],
        slots: contrato.slots.map((s) => ({
          chave: slotKey(s.address, s.key),
          key: s.key,
          expects: s.expects,
          onde: describeAddress(s.address),
          contextoAntes: s.contextBefore,
          contextoDepois: s.contextAfter,
        })),
      };
    }),
  };
}
