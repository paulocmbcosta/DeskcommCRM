/**
 * Os números de telefone da organização — o cadastro que a tela de Conexões ›
 * Telefone faz (spec 20 §7). Um número = uma linha de `channel_sessions` com o
 * provider do tronco SIP.
 *
 * A senha entra em claro SÓ aqui, é cifrada DENTRO do mesmo comando SQL
 * (`fn_encrypt_oauth`) e nunca é lida de volta por este módulo: a leitura
 * pública (`numerosDaOrg`) não seleciona a coluna. Editar sem mandar senha
 * mantém a que está guardada — mas só enquanto a CONTA é a mesma (ver
 * `atualizarNumero`).
 *
 * O DESTINO das ligações (fase 2) é um time OU um menu de voz — nunca os dois
 * (CHECK `channel_sessions_sip_destino_check`, migration 0288). Apontar para um
 * menu é uma das três escritas que dependem de o menu estar ATIVO: por isso a
 * gravação do número corre numa transação com prazo de trava (`emTransacao`,
 * `PRAZO_DA_TRAVA`) e trava a linha do menu (`travarMenuAtivo`) ANTES de
 * escrever — sem a trava, arquivar o menu ao mesmo tempo deixaria o número
 * tocando um menu arquivado. O contrato está no comentário de `travarMenuAtivo`.
 *
 * O destino não vai ao Asterisk: o worker o lê do banco a cada ligação
 * (`troncoPorId`, em `controle.ts`). Trocar só o destino não precisa empurrar
 * tronco nenhum — a rota empurra porque o PATCH é o formulário inteiro.
 */
import { z } from "zod";

import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { PRAZO_DA_TRAVA } from "@/lib/telefonia/falas";
import { situacaoDoMenuParaNumero, travarMenuAtivo } from "@/lib/telefonia/menus";
import { numeroParaLigar } from "@/lib/telefonia/numero";
import { confirmar, desfazer, emTransacao, type PoolDeTransacao } from "@/lib/telefonia/transacao";

import { motivoDoServidorInvalido, normalizarServidor, prefixoDeDiscagemValido, usuarioSipValido } from "./conta-sip";
import { PROVIDER } from "./repositorio";

export const numeroSchema = z
  .object({
    nome: z.string().trim().min(1).max(80),
    numero: z.string().trim().min(8).max(30),
    // A MESMA régua que o worker aplica antes de empurrar o tronco
    // (`conta-sip.ts`): a coluna também é gravável pela REST, sem este Zod.
    servidor: z
      .string()
      .transform(normalizarServidor)
      .superRefine((s, ctx) => {
        const motivo = motivoDoServidorInvalido(s);
        if (motivo === "interno") {
          ctx.addIssue({
            code: "custom",
            message: "Use o endereço público da operadora — endereço interno, localhost ou nome sem domínio não são aceitos.",
          });
        } else if (motivo) {
          ctx.addIssue({ code: "custom", message: "servidor inválido" });
        }
      }),
    porta: z.coerce.number().int().min(1).max(65535).default(5060),
    transporte: z.enum(["udp", "tcp"]).default("udp"),
    usuario: z.string().trim().refine(usuarioSipValido, "usuário inválido"),
    senha: z.string().min(1).max(128).optional(),
    time_id: z.string().uuid().nullable().default(null),
    // O MENU de voz que atende as ligações deste número (fase 2). Excludente com
    // `time_id`. AUSENTE (`undefined`) = manter o guardado, pela mesma razão do
    // prefixo: uma aba aberta antes da atualização não pode apagar o menu.
    menu_id: z.string().uuid().nullable().optional(),
    // O que vai antes do DDD na saída (`0`, `015`…). Vazio ou `null` = sem
    // prefixo. AUSENTE (`undefined`) = manter o guardado: uma aba aberta antes
    // da atualização manda o formulário sem este campo, e apagar o prefixo em
    // silêncio faria toda ligação dela voltar a ser recusada pela operadora.
    // Não é identidade da conta: mudar só o prefixo não pede a senha.
    prefixo: z
      .string()
      .trim()
      .nullable()
      .optional()
      .refine((p) => p == null || p === "" || prefixoDeDiscagemValido(p), {
        message: "O prefixo de discagem tem de 1 a 4 dígitos, só números (ex.: 0 ou 015).",
      })
      .transform((p) => (p === undefined ? undefined : p ? p : null)),
  })
  .strict();

export type EntradaDoNumero = z.infer<typeof numeroSchema>;

export interface NumeroPublico {
  id: string;
  nome: string | null;
  numero: string | null;
  servidor: string;
  porta: number;
  transporte: "udp" | "tcp";
  usuario: string;
  /** Prefixo de discagem da saída; `null` = DDD + número. */
  prefixo: string | null;
  time_id: string | null;
  time_nome: string | null;
  /** O menu de voz que atende este número (excludente com `time_id`). */
  menu_id: string | null;
  menu_nome: string | null;
  status: string;
  status_reason: string | null;
  created_at: string;
}

export async function numerosDaOrg(db: Queryable, organizationId: string): Promise<NumeroPublico[]> {
  const { rows } = await db.query<NumeroPublico>(
    `select c.id, c.display_name as nome, c.phone_number as numero, c.sip_server as servidor,
            coalesce(c.sip_port, 5060) as porta, coalesce(c.sip_transport, 'udp') as transporte,
            c.sip_username as usuario, c.sip_dial_prefix as prefixo, c.sip_team_id as time_id, t.name as time_nome,
            c.sip_menu_id as menu_id, pm.name as menu_nome,
            c.status, c.status_reason, c.created_at
       from channel_sessions c
       left join attendance_teams t on t.id = c.sip_team_id and t.organization_id = c.organization_id
       left join phone_menus pm on pm.id = c.sip_menu_id and pm.organization_id = c.organization_id
      where c.organization_id = $1 and c.provider = $2 and c.archived_at is null
      order by c.created_at asc`,
    [organizationId, PROVIDER],
  );
  return rows;
}

export type FalhaDoCadastro =
  | "numero_invalido"
  | "time_invalido"
  | "senha_obrigatoria"
  | "senha_obrigatoria_na_troca"
  | "numero_ja_existe"
  | "conta_ja_usada"
  | "nao_encontrado"
  | "destino_duplo"
  | "menu_invalido"
  | "menu_com_fala_pendente"
  /** O prazo da trava venceu: o número ou o menu escolhido está sendo gravado por outra requisição. */
  | "gravacao_em_andamento";

/** O HTTP de cada recusa do cadastro — o mesmo nas duas rotas. */
export function statusDaFalhaDoCadastro(motivo: FalhaDoCadastro): 404 | 409 | 422 {
  if (motivo === "nao_encontrado") return 404;
  if (motivo === "gravacao_em_andamento") return 409;
  return 422;
}

/** Para onde vão as ligações do número. No máximo um dos dois; os dois nulos = sem destino. */
export interface DestinoDoNumero {
  time_id: string | null;
  menu_id: string | null;
}

/**
 * O destino antes e depois de uma gravação, lidos DENTRO da transação que gravou
 * (o antes sob a trava da linha do número, o depois pelo `returning`) — a
 * auditoria da troca não conta outra história quando duas edições se cruzam.
 */
export interface TrocaDeDestino {
  de: DestinoDoNumero;
  para: DestinoDoNumero;
}

export function destinoMudou(t: TrocaDeDestino): boolean {
  return t.de.time_id !== t.para.time_id || t.de.menu_id !== t.para.menu_id;
}

/**
 * O número exibido (DID) em E.164. Geográfico com DDD pela régua da discagem;
 * 0800 e 400x também valem aqui — são números que empresa CONTRATA para receber,
 * mesmo que o CRM não disque para eles.
 */
function e164DoNumero(bruto: string): string | null {
  const n = numeroParaLigar(bruto);
  if (n.ok) return n.e164;
  if (n.motivo !== "nao_geografico") return null;
  const d = bruto.replace(/\D/g, "").replace(/^0/, "");
  return d.length >= 7 && d.length <= 11 ? `+55${d}` : null;
}

async function timeDaOrg(db: Queryable, organizationId: string, timeId: string | null): Promise<boolean> {
  if (!timeId) return true;
  const { rows } = await db.query(
    "select 1 from attendance_teams where id = $1 and organization_id = $2 and archived_at is null",
    [timeId, organizationId],
  );
  return rows.length > 0;
}

/**
 * O menu que o número vai tocar, SOB a trava dele — o contrato de `travarMenuAtivo`:
 * `conexao` é a da transação já aberta, com prazo; a escrita vem depois, na mesma
 * transação. `null` da trava = arquivado, de outra organização ou inexistente.
 * A fala é conferida DEPOIS da trava, num comando separado (snapshot novo, que já
 * vê o que um salvar do menu confirmou): um menu sem áudio mandaria toda ligação
 * direto ao time padrão (desenho, §4.7).
 */
async function recusaDoMenu(conexao: Queryable, organizationId: string, menuId: string): Promise<FalhaDoCadastro | null> {
  if (!(await travarMenuAtivo(conexao, organizationId, menuId))) return "menu_invalido";
  const situacao = await situacaoDoMenuParaNumero(conexao, organizationId, menuId);
  if (situacao === "inexistente") return "menu_invalido";
  if (situacao === "pendente") return "menu_com_fala_pendente";
  return null;
}

/**
 * A recusa do BANCO que a validação de cima já devia ter pego — vira a mesma
 * mensagem em vez de um 500: a conta ou o número repetidos (23505), o time ou o
 * menu que sumiram entre a conferência e a escrita (23503, a FK de cada um), e o
 * time E o menu juntos (23514, o CHECK da 0288).
 */
function traduzirRecusaDoBanco(e: unknown): { ok: false; motivo: FalhaDoCadastro } | null {
  const err = e as { code?: string; constraint?: string } | null;
  const constraint = err?.constraint ?? "";
  let motivo: FalhaDoCadastro | null = null;
  if (err?.code === "23505") motivo = constraint === "channel_sessions_sip_conta_unique" ? "conta_ja_usada" : "numero_ja_existe";
  else if (err?.code === "23503" && constraint.includes("sip_menu_id")) motivo = "menu_invalido";
  else if (err?.code === "23503" && constraint.includes("sip_team_id")) motivo = "time_invalido";
  else if (err?.code === "23514" && constraint === "channel_sessions_sip_destino_check") motivo = "destino_duplo";
  return motivo ? { ok: false, motivo } : null;
}

type ResultadoDoCriar = { ok: true; id: string } | { ok: false; motivo: FalhaDoCadastro };

/**
 * `pool` = o da rota: a conferência do time sai solta; a gravação, numa transação
 * (`emTransacao`) — nascer apontando para um menu é apontar para ele, com a trava.
 */
export async function criarNumero(
  pool: Queryable & PoolDeTransacao,
  organizationId: string,
  e: EntradaDoNumero,
): Promise<ResultadoDoCriar> {
  const numero = e164DoNumero(e.numero);
  if (!numero) return { ok: false, motivo: "numero_invalido" };
  if (!e.senha) return { ok: false, motivo: "senha_obrigatoria" };
  if (e.time_id && e.menu_id) return { ok: false, motivo: "destino_duplo" };
  if (!(await timeDaOrg(pool, organizationId, e.time_id))) return { ok: false, motivo: "time_invalido" };
  const senha = e.senha;

  return emTransacao<ResultadoDoCriar>(
    pool,
    PRAZO_DA_TRAVA,
    async (conexao) => {
      if (e.menu_id) {
        const recusa = await recusaDoMenu(conexao, organizationId, e.menu_id);
        if (recusa) return desfazer({ ok: false, motivo: recusa });
      }
      const { rows } = await conexao.query<{ id: string }>(
        `insert into channel_sessions
           (organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
            sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted, sip_team_id,
            sip_dial_prefix, sip_menu_id)
         values ($1, $2, decode('00', 'hex'), 'STARTING', $3, $4, $5, $6, $7, $8,
                 public.fn_encrypt_oauth($9), $10, $11, $12)
         returning id`,
        [
          organizationId,
          PROVIDER,
          e.nome,
          numero,
          e.servidor,
          e.porta,
          e.transporte,
          e.usuario,
          senha,
          e.time_id,
          e.prefixo ?? null,
          e.menu_id ?? null,
        ],
      );
      return confirmar({ ok: true, id: rows[0]!.id });
    },
    traduzirRecusaDoBanco,
  );
}

interface ContaGuardada {
  servidor: string;
  porta: number;
  transporte: string;
  usuario: string;
}

/** A linha do número como `atualizarNumero` a lê sob a trava: a conta e o destino de agora. */
type NumeroGuardado = ContaGuardada & Partial<DestinoDoNumero>;

/**
 * A senha é da CONTA — usuário naquele servidor, por aquela porta e transporte.
 * Trocar qualquer um dos quatro sem digitar a senha de novo mandaria a senha
 * guardada para outra conta: com o servidor trocado, o Asterisk responde ao
 * desafio de autenticação de QUALQUER host que o admin digitar, e o digest que
 * sai dali é quebrável offline. Quem edita a tela nunca viu a senha (ela só é
 * escrita), então editar não pode ser o jeito de levá-la a outro lugar.
 */
function trocouAConta(guardada: ContaGuardada, e: EntradaDoNumero): boolean {
  return (
    guardada.servidor !== e.servidor ||
    Number(guardada.porta) !== e.porta ||
    guardada.transporte !== e.transporte ||
    guardada.usuario !== e.usuario
  );
}

type ResultadoDoAtualizar = { ok: true; destino: TrocaDeDestino } | { ok: false; motivo: FalhaDoCadastro };

/**
 * Edita o número numa transação com prazo (`emTransacao`, `PRAZO_DA_TRAVA`), em
 * comandos SEPARADOS:
 *  1. lê a conta e o destino de agora travando a linha do número
 *     (`for no key update`: serializa duas edições do mesmo número sem segurar a
 *     ligação que entra — o INSERT em `voice_calls` confere a FK com `key share`,
 *     que não conflita com ela);
 *  2. confere a senha contra a CONTA guardada (`trocouAConta`);
 *  3. se o corpo aponta para um menu, trava a linha dele e confere a fala
 *     (`recusaDoMenu`) — ANTES do UPDATE, como pede `travarMenuAtivo`;
 *  4. grava e devolve o destino que ficou (`returning`).
 * Recusa em qualquer passo desfaz, sem escrita.
 */
export async function atualizarNumero(
  pool: Queryable & PoolDeTransacao,
  organizationId: string,
  id: string,
  e: EntradaDoNumero,
): Promise<ResultadoDoAtualizar> {
  const numero = e164DoNumero(e.numero);
  if (!numero) return { ok: false, motivo: "numero_invalido" };
  if (e.time_id && e.menu_id) return { ok: false, motivo: "destino_duplo" };
  if (!(await timeDaOrg(pool, organizationId, e.time_id))) return { ok: false, motivo: "time_invalido" };

  return emTransacao<ResultadoDoAtualizar>(
    pool,
    PRAZO_DA_TRAVA,
    async (conexao) => {
      const { rows: atuais } = await conexao.query<NumeroGuardado>(
        `select lower(sip_server) as servidor, coalesce(sip_port, 5060) as porta,
                coalesce(sip_transport, 'udp') as transporte, sip_username as usuario,
                sip_team_id as time_id, sip_menu_id as menu_id
           from channel_sessions
          where id = $1 and organization_id = $2 and provider = $3 and archived_at is null
          for no key update`,
        [id, organizationId, PROVIDER],
      );
      const atual = atuais[0];
      if (!atual) return desfazer({ ok: false, motivo: "nao_encontrado" });
      if (!e.senha && trocouAConta(atual, e)) return desfazer({ ok: false, motivo: "senha_obrigatoria_na_troca" });
      if (e.menu_id) {
        const recusa = await recusaDoMenu(conexao, organizationId, e.menu_id);
        if (recusa) return desfazer({ ok: false, motivo: recusa });
      }

      // A última cláusula repete a regra de `trocouAConta` DENTRO do comando: sem
      // ela, duas edições simultâneas (uma trocando o servidor com a senha nova,
      // outra salvando o formulário antigo sem senha) terminavam com a senha nova
      // apontada para o servidor antigo. O prefixo e o destino ficam fora dela:
      // não são conta. O menu: `$14` = o corpo mandou `menu_id` (grava `$15`,
      // inclusive nulo); sem ele, escolher um time tira o menu (o CHECK da 0288
      // não aceita os dois) e não escolher nada mantém o guardado.
      const { rows } = await conexao.query<DestinoDoNumero>(
        `update channel_sessions
            set display_name = $4, phone_number = $5, sip_server = $6, sip_port = $7,
                sip_transport = $8, sip_username = $9, sip_team_id = $10,
                sip_password_encrypted = case when $11::text is null then sip_password_encrypted
                                              else public.fn_encrypt_oauth($11) end,
                sip_dial_prefix = case when $12::boolean then $13::text else sip_dial_prefix end,
                sip_menu_id = case when $14::boolean then $15::uuid
                                   when $10::uuid is not null then null
                                   else sip_menu_id end,
                status = 'STARTING', status_reason = null, updated_at = now()
          where id = $1 and organization_id = $2 and provider = $3 and archived_at is null
            and ($11::text is not null
                 or (lower(sip_server) = $6 and coalesce(sip_port, 5060) = $7
                     and coalesce(sip_transport, 'udp') = $8 and sip_username = $9))
          returning sip_team_id as time_id, sip_menu_id as menu_id`,
        [
          id,
          organizationId,
          PROVIDER,
          e.nome,
          numero,
          e.servidor,
          e.porta,
          e.transporte,
          e.usuario,
          e.time_id,
          e.senha ?? null,
          e.prefixo !== undefined,
          e.prefixo ?? null,
          e.menu_id !== undefined,
          e.menu_id ?? null,
        ],
      );
      const para = rows[0];
      if (!para) return desfazer({ ok: false, motivo: "nao_encontrado" });
      return confirmar({
        ok: true,
        destino: { de: { time_id: atual.time_id ?? null, menu_id: atual.menu_id ?? null }, para },
      });
    },
    traduzirRecusaDoBanco,
  );
}

/**
 * Remover = arquivar: as conversas e ligações apontam para esta linha, e o
 * histórico delas não some junto com o número. O Asterisk solta o registro na
 * próxima sincronização (ou na hora, pela rota).
 */
export async function arquivarNumero(db: Queryable, organizationId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `update channel_sessions
        set archived_at = now(), status = 'STOPPED', status_reason = 'removido', updated_at = now()
      where id = $1 and organization_id = $2 and provider = $3 and archived_at is null`,
    [id, organizationId, PROVIDER],
  );
  return (rowCount ?? 0) > 0;
}

export const MENSAGEM_DA_FALHA: Record<FalhaDoCadastro, string> = {
  numero_invalido: "O número precisa ser um telefone brasileiro com DDD.",
  time_invalido: "Esse time não existe nesta organização.",
  senha_obrigatoria: "Informe a senha da conta SIP.",
  senha_obrigatoria_na_troca:
    "Ao trocar o servidor, a porta, o transporte ou o usuário, digite a senha da conta SIP de novo.",
  numero_ja_existe: "Esse número já está conectado nesta organização.",
  conta_ja_usada: "Essa conta SIP já está conectada nesta instalação.",
  nao_encontrado: "Número não encontrado.",
  destino_duplo: "Escolha só um destino: um time ou um menu.",
  menu_invalido: "Esse menu não existe nesta organização ou foi arquivado.",
  menu_com_fala_pendente:
    "A fala desse menu ainda não está pronta. Gere a prévia e salve o menu na aba Menus antes de ligar o menu ao número.",
  gravacao_em_andamento: "O número ou o menu escolhido está sendo alterado agora. Tente de novo em instantes.",
};
