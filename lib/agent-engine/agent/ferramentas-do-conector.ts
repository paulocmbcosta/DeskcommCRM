/**
 * AS FERRAMENTAS DO CONECTOR NO TURNO DO AGENTE — consultar o cliente no sistema
 * de gestão e enviar a cobrança dele.
 *
 * O motor não conhece o IXC: pede ao registro o conector da organização que
 * declara `agente` (lib/conectores/registro.ts) e fala com ele pelo contrato de
 * lib/conectores/tipos.ts. A cerca é tests/unit/conectores-cerca.test.ts.
 *
 * O que mora AQUI, e não no conector, é o que depende de conversa, atendimento e
 * agente:
 *   - a conversa, o contato, o telefone e o canal vêm do closure do turno — o
 *     modelo nunca passa contato, conversa nem id de fatura;
 *   - as 3 tentativas de identificação por ATENDIMENTO, contadas pela auditoria
 *     (com chão em memória — `EstadoDoTurno.recusasNoTurno` — para quando o
 *     `audit()` best-effort não confirma a escrita: ver `falha`/`avisarFalhaInterna`
 *     e a nota da revisão de qualidade no cabeçalho de `respostaDaConsulta`);
 *   - a cobrança é NO MÁXIMO UMA por turno (`EstadoDoTurno.cobrancaTentadaNoTurno`)
 *     — o teto de envios do turno (2+2>3) sozinho não impede duas tentativas;
 *   - a auditoria com o agente como ator;
 *   - a SAÍDA: cada mensagem da cobrança passa pela cadeia before-send do turno
 *     (`PortaDeEnvioDoTurno`, montada no inbound-turn), nunca por fora;
 *   - o que o MODELO lê: valores e datas formatados, a `orientacao` de cada caso,
 *     e nada de id, CPF, endereço, IP, MAC ou senha (decisão de 21/09).
 *
 * Spec: docs/superpowers/specs/2026-09-22-ia-envia-cobranca-ixc-design.md.
 */
import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { tool, type ToolSet } from 'ai';
import type pg from 'pg';
import { z } from 'zod';

import { audit } from '@/lib/audit';
import type { IdentidadeDoTelefone } from '@/lib/channels/capabilities';
import { carimbarEstado, lerCredencial, lerLimiteDeCobranca } from '@/lib/conectores/conexao';
import {
  DESCRICAO_CONSULTAR_CLIENTE,
  DESCRICAO_ENVIAR_COBRANCA,
  FERRAMENTA_CONSULTAR_CLIENTE,
  FERRAMENTA_ENVIAR_COBRANCA,
  IDS_DAS_FERRAMENTAS_DO_CONECTOR,
} from '@/lib/conectores/ferramentas-do-agente';
import { conectorDoAgente } from '@/lib/conectores/registro';
import {
  FalhaDoConector,
  type CapacidadeDoAgente,
  type ConectorId,
  type FaturaParaAgente,
  type MensagemDaCobranca,
  type ResultadoDaCobranca,
  type ResultadoDaConsulta,
} from '@/lib/conectores/tipos';

import type { ChannelSendResult } from '../channel-adapter';
import type { Logger } from '../obs/logger';

/** Na 3ª recusa de identidade no atendimento, a IA para de pedir e transfere (decisão de 21/09). */
export const TENTATIVAS_DE_IDENTIFICACAO = 3;
/** Uma cobrança são duas mensagens: o arquivo com a legenda e o código para copiar. */
export const MENSAGENS_POR_COBRANCA = 2;

export type EnvioDoTurno = { ok: true; outcome: ChannelSendResult } | { ok: false; code: string; message: string };

/** A saída do turno, montada no inbound-turn: cadeia before-send + canal + `seq`. */
export interface PortaDeEnvioDoTurno {
  /** Quantas mensagens ainda cabem neste turno (teto de envios). */
  vagas(): number;
  enviar(mensagem: MensagemDaCobranca): Promise<EnvioDoTurno>;
}

export interface PedidoDeFerramentas {
  pool: pg.Pool;
  supabase: SupabaseClient;
  log: Logger;
  tenantId: string;
  leadId: string;
  conversationId: string;
  channelSessionId: string;
  /**
   * O telefone do CONTATO e se ele é identidade NESTE canal — resolvidos UMA vez
   * pelo turno (o turno já lê os dois: o telefone vem do `get_lead_context` e o
   * provider já é lido para decidir `send_template`) e passados aqui, em vez de
   * cada chamada de ferramenta consultar `contacts`/`channel_sessions` de novo.
   */
  telefone: string | null;
  identidadeDoTelefone: IdentidadeDoTelefone;
  toolIds: readonly string[];
  agentId: string | null;
  saida: PortaDeEnvioDoTurno;
  agora: () => Date;
}

export interface FerramentasDoConector {
  tools: ToolSet;
  /** Ligadas na tela sem conector que as sirva nesta organização — vira aviso na Central. */
  ausentes: string[];
}

interface ConectorDoTurno {
  id: ConectorId;
  agente: CapacidadeDoAgente;
}

/**
 * O que persiste ENTRE chamadas de ferramenta DENTRO do mesmo turno (o modelo
 * pode chamar `crm_consultar_cliente_erp`/`crm_enviar_cobranca_erp` várias vezes
 * num turno só). Uma instância por turno, criada em `montarFerramentasDoConector`
 * e fechada nas duas execuções.
 */
interface EstadoDoTurno {
  /**
   * Recusas de identidade JÁ CONTADAS neste turno, mesmo que o `audit()` que as
   * grava (best-effort) não tenha confirmado a escrita. Sem este chão, uma
   * auditoria que engole erro em silêncio faz `recusasNoAtendimento` (que LÊ
   * `api_audit_log`) devolver 0 para sempre — o único limite contra varredura de
   * CPF+nascimento vira ilimitado sem ninguém perceber. `tentativasUsadas` usa o
   * MAIOR entre isto e a leitura do banco.
   */
  recusasNoTurno: { n: number };
  /**
   * Uma fatura só pode ser cobrada UMA vez por turno. A aritmética do teto de
   * envios (2 mensagens por cobrança, teto tipicamente 3) sozinha não impede uma
   * 2ª chamada com vagas de sobra — e nada mais no motor de-duplica isso (é
   * decisão explícita do conector: ver o cabeçalho de `PedidoDeCobranca`).
   */
  cobrancaTentadaNoTurno: { valor: boolean };
  /**
   * A ferramenta de ENVIAR está ligada neste turno? Ela é `critico` (não entra
   * por pacote) — o caso comum é a consulta ligada sozinha. `orientacaoDaConsulta`
   * não pode mandar chamar uma ferramenta que o agente não tem.
   */
  podeEnviar: boolean;
}

type Resposta = Record<string, unknown>;

/** O veto da cadeia de saída, levado por dentro de `enviarCobranca` do conector até aqui. */
class VetoDaSaida extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VetoDaSaida';
  }
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
// `Intl.NumberFormat('pt-BR')` separa "R$" do valor com um espaço FIXO (U+00A0,
// não o espaço comum) — o `Intl.Segmenter`/`toLocaleString` do Node atual segue o
// CLDR à risca. Uma frase que a IA copia pro cliente com esse caractere invisível
// é indistinguível a olho nu e ilegível em grep; troca-se pelo espaço comum.
const valor = (cents: number): string => BRL.format(cents / 100).replace(/ /g, ' ');
const dataBr = (ymd: string | null): string | null => {
  const [a, m, d] = (ymd ?? '').split('-');
  return a && m && d ? `${d}/${m}/${a}` : null;
};
const faturaDoModelo = (f: FaturaParaAgente): Resposta => ({
  vencimento: dataBr(f.vencimento),
  valor: valor(f.valorCents),
  ...(f.diasDeAtraso > 0 ? { dias_de_atraso: f.diasDeAtraso } : {}),
});

const TRANSFERIR_COBRANCA = 'transfira a conversa para o time que cuida de cobrança/financeiro';

/** `FalhaDoConector`: o ERP não respondeu ou recusou — a frase pode citar o sistema de gestão. */
function indisponivel(): Resposta {
  return {
    ok: false,
    estado: 'sistema_indisponivel',
    orientacao:
      'Não consegui consultar o sistema de gestão agora. Diga isso ao cliente com naturalidade e ' +
      'transfira a conversa para uma pessoa — não invente situação, valor nem vencimento.',
  };
}

/**
 * Falha NOSSA (bug, Storage fora do ar, `lerLimiteDeCobranca` lançando) — NUNCA o
 * ERP recusando. A frase não pode citar "sistema de gestão": culpar o ERP por um
 * bug nosso manda quem administra procurar defeito no lugar errado. Ver `falha`.
 */
function indisponivelNeutro(acao: 'consultar' | 'cobrar'): Resposta {
  const frase = acao === 'cobrar' ? 'não consegui gerar a cobrança agora' : 'não consegui consultar o cliente agora';
  return {
    ok: false,
    estado: 'sistema_indisponivel',
    orientacao:
      `Desculpe, ${frase} — foi um erro interno nosso. Diga isso ao cliente com naturalidade e transfira ` +
      'a conversa para uma pessoa — não invente situação, valor nem vencimento.',
  };
}

function esgotadas(): Resposta {
  return {
    ok: false,
    estado: 'tentativas_esgotadas',
    orientacao:
      'Não foi possível confirmar a identidade neste atendimento. Não peça mais dados e não fale de ' +
      `valores: diga que vai passar para o setor de cobrança e ${TRANSFERIR_COBRANCA}.`,
  };
}

export async function montarFerramentasDoConector(p: PedidoDeFerramentas): Promise<FerramentasDoConector> {
  const pedidas = IDS_DAS_FERRAMENTAS_DO_CONECTOR.filter((id) => p.toolIds.includes(id));
  if (pedidas.length === 0) return { tools: {}, ausentes: [] };
  const conector = await conectorDoAgente(p.supabase, p.tenantId);
  if (!conector) return { tools: {}, ausentes: pedidas };

  const estado: EstadoDoTurno = {
    recusasNoTurno: { n: 0 },
    cobrancaTentadaNoTurno: { valor: false },
    podeEnviar: pedidas.includes(FERRAMENTA_ENVIAR_COBRANCA),
  };

  const tools: ToolSet = {};
  if (pedidas.includes(FERRAMENTA_CONSULTAR_CLIENTE)) {
    tools[FERRAMENTA_CONSULTAR_CLIENTE] = tool({
      description: DESCRICAO_CONSULTAR_CLIENTE,
      // Schema LARGO de propósito: dado mal formatado tem de chegar aqui e voltar
      // como `orientacao` que o modelo entende, nunca como erro de validação do SDK.
      inputSchema: z
        .object({
          cpf_cnpj: z.string().optional().describe('CPF ou CNPJ do titular, como o cliente digitou'),
          data_nascimento: z.string().optional().describe('data de nascimento do titular, AAAA-MM-DD'),
        })
        .passthrough(),
      execute: ({ cpf_cnpj, data_nascimento }) => consultar(p, conector, estado, cpf_cnpj, data_nascimento),
    });
  }
  if (pedidas.includes(FERRAMENTA_ENVIAR_COBRANCA)) {
    tools[FERRAMENTA_ENVIAR_COBRANCA] = tool({
      description: DESCRICAO_ENVIAR_COBRANCA,
      inputSchema: z
        .object({ forma: z.string().optional().describe('"pix" (padrão) ou "boleto" — boleto só se o cliente pedir') })
        .passthrough(),
      execute: ({ forma }) => enviarCobranca(p, conector, estado, forma),
    });
  }
  return { tools, ausentes: [] };
}

/** Recusas de identidade no ATENDIMENTO atual — cliente que volta noutro atendimento recomeça do zero. */
async function recusasNoAtendimento(p: PedidoDeFerramentas): Promise<number> {
  const { rows } = await p.pool.query<{ n: number }>(
    `select count(*)::int as n
       from api_audit_log a
      where a.organization_id = $1
        and a.action = 'conector.identificacao_recusada'
        and a.resource_type = 'conversation'
        and a.resource_id = $2::uuid
        and a.created_at >= coalesce(
              (select v.service_started_at from conversations v
                where v.id = $2::uuid and v.organization_id = $1),
              '-infinity'::timestamptz)`,
    [p.tenantId, p.conversationId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * O maior entre o que o BANCO confirma e o que este TURNO já contou em memória.
 * Degrada FECHADO: se o `audit()` de uma recusa não confirmar a escrita (é
 * best-effort — ver o cabeçalho de `lib/audit/index.ts`), `recusasNoAtendimento`
 * sozinho ficaria preso em 0 e o limite de 3 tentativas viraria ilimitado em
 * silêncio DENTRO deste turno. O chão em memória não sobrevive entre turnos —
 * quem sobrevive é o banco —, mas cobre exatamente a janela em que a auditoria
 * pode estar falhando SEM que ninguém tenha visto ainda.
 */
async function tentativasUsadas(p: PedidoDeFerramentas, estado: EstadoDoTurno): Promise<number> {
  return Math.max(await recusasNoAtendimento(p), estado.recusasNoTurno.n);
}

const ator = (p: PedidoDeFerramentas) => ({ ator: 'ai_agent', agente_id: p.agentId });

/**
 * Nossa falha ao operar o conector (bug, Storage fora do ar, limite ilegível) —
 * nunca o ERP recusando (isso é `FalhaDoConector`, tratado em `falha` sem passar
 * por aqui). Abre item na Central: log de worker em VPS não é superfície de
 * nada, mesmo racional de `avisarCapacidadesAusentes` (`inbound-turn.ts`) — não
 * importada daqui de propósito, para não abrir um ciclo de import entre os dois
 * módulos (`inbound-turn.ts` importa `montarFerramentasDoConector` DESTE
 * arquivo). Dedup por (organização, kind, título): o título É a chave que separa
 * este aviso do de capacidades MCP ausentes, que usa o MESMO `kind`
 * (`capabilities_missing`, vocabulário existente — sem migration) — sem isso, um
 * item já aberto por uma causa escondia silenciosamente a outra. Best-effort:
 * se ATÉ o aviso falhar, o turno continua.
 */
async function avisarFalhaInterna(p: PedidoDeFerramentas, detalhe: string): Promise<void> {
  const titulo = 'O agente não conseguiu operar o sistema de gestão';
  try {
    await p.pool.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       select $1, 'capabilities_missing', 'critical', $2, $3, 'conversation', $4
        where not exists (
          select 1 from agent_inbox_items
           where organization_id = $1 and kind = 'capabilities_missing' and status = 'open' and title = $2
        )`,
      [
        p.tenantId,
        titulo,
        'Uma falha interna (não do sistema de gestão) impediu a ferramenta do conector de responder ao ' +
          `cliente neste atendimento. Motivo técnico: ${detalhe}`,
        p.conversationId,
      ],
    );
  } catch (err) {
    p.log.warn('aviso de falha interna do conector não foi gravado', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }
}

async function falha(p: PedidoDeFerramentas, conector: ConectorDoTurno, err: unknown, acao: 'consultar' | 'cobrar'): Promise<Resposta> {
  if (err instanceof FalhaDoConector) {
    // O mesmo laço do painel: o admin vê em Configurações › Conectores o que a IA encontrou.
    if (err.motivo !== 'recurso_indisponivel') {
      // `carimbarEstado` real nunca lança (ver o cabeçalho dela); o try/catch aqui
      // é só para não deixar o turno cair se um mock de teste ou um wrapper futuro
      // devolver uma promise rejeitada — nunca a lida por `.catch` num valor que
      // pode não ser uma promise.
      try {
        await carimbarEstado(p.supabase, p.tenantId, conector.id, 'erro', err.motivo);
      } catch {
        // de propósito: ver o comentário acima
      }
    }
    p.log.warn('sistema de gestão indisponível na ferramenta do agente', { conector: conector.id, motivo: err.motivo });
    return indisponivel();
  }
  // Falha NOSSA: não carimba o conector (a conexão com o ERP não é o problema) e
  // não culpa o "sistema de gestão" na frase do cliente — ver `indisponivelNeutro`.
  const detalhe = (err instanceof Error ? err.message : String(err)).slice(0, 200);
  p.log.error('ferramenta do conector falhou', { conector: conector.id, error: detalhe });
  await avisarFalhaInterna(p, detalhe);
  return indisponivelNeutro(acao);
}

async function voltouAoAr(p: PedidoDeFerramentas, conector: ConectorDoTurno, status: string): Promise<void> {
  if (status !== 'erro') return;
  try {
    await carimbarEstado(p.supabase, p.tenantId, conector.id, 'ativa', null);
  } catch {
    // de propósito: ver o comentário em `falha`
  }
}

async function consultar(
  p: PedidoDeFerramentas,
  conector: ConectorDoTurno,
  estado: EstadoDoTurno,
  cpfCnpj: string | undefined,
  dataNascimento: string | undefined,
): Promise<Resposta> {
  try {
    const credencial = await lerCredencial(p.supabase, p.tenantId, conector.id);
    if (!credencial) return indisponivel();
    const cpf = cpfCnpj?.trim() || undefined;
    const nascimento = dataNascimento?.trim() || undefined;
    // NÃO gateamos aqui por "sem cpf/nascimento": o caso legítimo é um HUMANO ter
    // vinculado o contato entre uma tentativa e outra, e uma chamada sem
    // argumentos precisa poder voltar `identificado`. O chão de tentativas mora
    // em `respostaDaConsulta`, DEPOIS de consultar o ERP de verdade.
    if ((cpf || nascimento) && (await tentativasUsadas(p, estado)) >= TENTATIVAS_DE_IDENTIFICACAO) return esgotadas();
    const r = await conector.agente.consultar({
      admin: p.supabase,
      credencial,
      orgId: p.tenantId,
      contactId: p.leadId,
      telefone: p.telefone,
      identidadeDoTelefone: p.identidadeDoTelefone,
      ...(cpf ? { cpfCnpj: cpf } : {}),
      ...(nascimento ? { dataNascimento: nascimento } : {}),
      agora: p.agora(),
    });
    await voltouAoAr(p, conector, credencial.status);
    return await respostaDaConsulta(p, conector, estado, r);
  } catch (err) {
    return falha(p, conector, err, 'consultar');
  }
}

function orientacaoDaConsulta(r: Extract<ResultadoDaConsulta, { estado: 'identificado' }>, limite: number, podeEnviar: boolean): string {
  const daVez = r.financeiro?.daVez;
  if (daVez && daVez.diasDeAtraso > limite) {
    return (
      `A fatura da vez tem ${daVez.diasDeAtraso} dias de atraso, acima do limite de ${limite}: NÃO envie ` +
      `a cobrança. Diga que a fatura foi encaminhada ao setor de cobrança e ${TRANSFERIR_COBRANCA}.`
    );
  }
  const partes: string[] = [];
  if (r.cliente.bloqueado === true) {
    partes.push(
      'O acesso está bloqueado. Se o cliente quiser pagar, envie a cobrança e explique que a liberação ' +
        'acontece depois que o pagamento for compensado — sem prometer prazo.',
    );
  }
  if (daVez) {
    // `podeEnviar` é a ferramenta de ENVIAR estar ligada NESTE turno — ligar o
    // pacote "Atender" não a liga (ela é `critico`), então o caso comum é a
    // consulta sozinha. Mandar chamar uma ferramenta que o agente não tem faz o
    // modelo tentar, falhar, e inventar uma correção pior.
    partes.push(
      podeEnviar
        ? `Para cobrar, use ${FERRAMENTA_ENVIAR_COBRANCA}: ela envia só a fatura da vez, por Pix, a menos que ` +
            'o cliente peça boleto. Não prometa enviar mais de uma fatura.'
        : `Você NÃO tem a ferramenta de enviar cobrança neste atendimento. Diga o valor (${valor(daVez.valorCents)}) ` +
            `e o vencimento (${dataBr(daVez.vencimento) ?? 'a data em aberto'}) ao cliente e ${TRANSFERIR_COBRANCA} — ` +
            'não prometa mandar boleto ou Pix você mesma.',
    );
  } else if (r.financeiro) {
    partes.push('Não há fatura que eu possa cobrar agora.');
  } else {
    partes.push('O financeiro não pôde ser lido agora: não afirme valores nem vencimentos.');
  }
  return partes.join(' ');
}

async function respostaDaConsulta(p: PedidoDeFerramentas, conector: ConectorDoTurno, estado: EstadoDoTurno, r: ResultadoDaConsulta): Promise<Resposta> {
  switch (r.estado) {
    case 'identificado': {
      // `auditoria` é o único ramo do resultado que pode carregar id — e é por
      // isso que ela vive separada: nada daqui entra na resposta do modelo.
      const vinculou = r.auditoria.vinculou;
      if (vinculou) {
        void audit({
          action: 'conector.vinculo_criado',
          organizationId: p.tenantId,
          resourceType: 'contact',
          resourceId: p.leadId,
          metadata: { conector: conector.id, cadastros: vinculou.cadastros, verificado_por: vinculou.verificadoPor, conversa: p.conversationId, ...ator(p) },
        });
      }
      const limite = await lerLimiteDeCobranca(p.supabase, p.tenantId, conector.id);
      const f = r.financeiro;
      const nd = 'indisponivel';
      return {
        ok: true,
        estado: 'identificado',
        cliente: {
          primeiro_nome: r.cliente.primeiroNome,
          situacao: r.cliente.situacao ?? nd,
          ...(r.cliente.motivoDaSituacao ? { motivo_da_situacao: r.cliente.motivoDaSituacao } : {}),
          bloqueado: r.cliente.bloqueado ?? nd,
          plano: r.cliente.plano ?? nd,
          cliente_desde: dataBr(r.cliente.clienteDesde) ?? nd,
          conexao: r.cliente.conexao ?? nd,
          tem_os_aberta: r.cliente.temOsAberta ?? nd,
        },
        financeiro: f
          ? {
              vencidas: f.vencidas.map(faturaDoModelo),
              proxima: f.proxima ? faturaDoModelo(f.proxima) : null,
              total_vencido: valor(f.totalVencidoCents),
              fatura_da_vez: f.daVez ? { ...faturaDoModelo(f.daVez), vai_para_a_cobranca: f.daVez.diasDeAtraso > limite } : null,
            }
          : nd,
        orientacao: orientacaoDaConsulta(r, limite, estado.podeEnviar),
      };
    }
    case 'precisa_cpf':
      // Chão de tentativas: sem isto, uma chamada SEM argumentos depois das 3
      // recusas volta a pedir CPF pra sempre (o telefone segue ambíguo no ERP) —
      // a IA entraria em laço com o cliente. Não gateamos ANTES de consultar
      // (ver `consultar`): um humano pode ter vinculado o contato entre uma
      // tentativa e outra, e aí o ERP responde `identificado`, não isto.
      if ((await tentativasUsadas(p, estado)) >= TENTATIVAS_DE_IDENTIFICACAO) return esgotadas();
      return { ok: false, estado: r.estado, orientacao: 'Este telefone está em mais de um cadastro. Peça o CPF (ou CNPJ) do titular e chame de novo com cpf_cnpj.' };
    case 'precisa_cpf_e_nascimento':
      if ((await tentativasUsadas(p, estado)) >= TENTATIVAS_DE_IDENTIFICACAO) return esgotadas();
      return { ok: false, estado: r.estado, orientacao: 'Para falar de conta e pagamento, peça o CPF (ou CNPJ) e a data de nascimento do titular e chame de novo com os dois.' };
    case 'cpf_invalido':
      return { ok: false, estado: r.estado, orientacao: 'O CPF/CNPJ informado não é válido. Peça para a pessoa conferir e digitar de novo.' };
    case 'data_invalida':
      return { ok: false, estado: r.estado, orientacao: 'A data informada não é uma data válida. Peça de novo (dia/mês/ano) e envie como AAAA-MM-DD.' };
    case 'nao_conferiu': {
      // O CPF existe e a data do cadastro é ilegível: o CLIENTE recebe a mesma
      // recusa, mas quem administra precisa ver — senão um ERP que grave a data
      // noutro formato recusa 100% das conferências em silêncio.
      if (r.dataIlegivel) {
        p.log.warn('conferência recusada com data de nascimento ilegível no sistema de gestão', {
          conector: conector.id,
          conversa: p.conversationId,
        });
      }
      // Conta a tentativa ANTES do `audit` (best-effort — pode falhar em
      // silêncio): é o chão de `tentativasUsadas`, ver o cabeçalho dela.
      estado.recusasNoTurno.n += 1;
      // AGUARDADA: é o contador das tentativas, não telemetria. Sem CPF nem data no metadata.
      await audit({
        action: 'conector.identificacao_recusada',
        organizationId: p.tenantId,
        resourceType: 'conversation',
        resourceId: p.conversationId,
        metadata: { conector: conector.id, ...ator(p) },
      });
      const restantes = Math.max(0, TENTATIVAS_DE_IDENTIFICACAO - (await tentativasUsadas(p, estado)));
      if (restantes === 0) return esgotadas();
      return {
        ok: false,
        estado: 'nao_conferiu',
        tentativas_restantes: restantes,
        orientacao: 'Os dados não conferem com o cadastro. NÃO diga qual deles está errado. Peça para a pessoa conferir e informar de novo.',
      };
    }
  }
}

/** Best-effort: remove um arquivo que subiu ao Storage mas cuja cobrança não terminou em `enviada`. */
async function removerArquivoOrfao(p: PedidoDeFerramentas, caminho: string): Promise<void> {
  try {
    const { error } = await p.supabase.storage.from('whatsapp-media').remove([caminho]);
    if (error) throw new Error(error.message);
  } catch (err) {
    p.log.warn('arquivo órfão da cobrança não removido do storage', {
      caminho,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 150),
    });
  }
}

async function enviarCobranca(p: PedidoDeFerramentas, conector: ConectorDoTurno, estado: EstadoDoTurno, formaBruta: string | undefined): Promise<Resposta> {
  const forma = formaBruta?.trim().toLowerCase() === 'boleto' ? 'boleto' : 'pix';
  const vagas = p.saida.vagas();
  if (vagas < MENSAGENS_POR_COBRANCA) {
    return {
      ok: false,
      error: {
        code: 'max_sends_per_turn',
        message:
          `a cobrança são ${MENSAGENS_POR_COBRANCA} mensagens e este turno só tem ${Math.max(0, vagas)} envio(s) ` +
          'livre(s). Não envie mais nada agora: encerre o turno. Na próxima vez, chame esta ferramenta ANTES de escrever texto.',
      },
    };
  }
  // Uma cobrança por turno: nem o teto de envios de cima impede uma 2ª chamada
  // com vagas de sobra, e mandar a MESMA fatura duas vezes é pior que não mandar.
  if (estado.cobrancaTentadaNoTurno.valor) {
    return {
      ok: false,
      error: {
        code: 'cobranca_ja_tentada_no_turno',
        message:
          'a cobrança já foi tentada neste turno — não chame esta ferramenta de novo agora, para não ' +
          'cobrar a mesma fatura duas vezes. Se precisar tentar de novo, espere a próxima mensagem do cliente.',
      },
    };
  }
  // Guardado FORA do try para o catch alcançar: se algo estourar depois do
  // upload (veto da saída, bug no conector), o arquivo não pode ficar órfão no
  // Storage — e um PDF/PNG com o nome e a legenda do cliente sobrevive à
  // anonimização de LGPD, porque nunca virou linha em `messages`.
  let caminhoDoArquivo: string | null = null;
  // Se ALGUMA das mensagens saiu `queued` (canal aceitou, ainda não confirmou —
  // sessão fora do ar), a resposta não pode dizer "enviada": `send_message` já
  // distingue os dois ("o canal aceitou... não reenvie"); a cobrança tem de
  // dizer o mesmo, não afirmar entrega concluída ao cliente.
  let houveQueued = false;
  try {
    const credencial = await lerCredencial(p.supabase, p.tenantId, conector.id);
    if (!credencial) return indisponivel();
    const limite = await lerLimiteDeCobranca(p.supabase, p.tenantId, conector.id);
    const r = await conector.agente.enviarCobranca({
      admin: p.supabase,
      credencial,
      orgId: p.tenantId,
      contactId: p.leadId,
      identidadeDoTelefone: p.identidadeDoTelefone,
      forma,
      limiteDeDias: limite,
      agora: p.agora(),
      portas: {
        // Storage-first, no prefixo que o handler de envio confere (`<org>/<conversa>/…`).
        // O ÚLTIMO segmento é o nome que o cliente vê — igual à rota do botão.
        //
        // O LATCH arma AQUI, não antes do `try`: é o primeiro efeito de
        // verdade rumo ao cliente (um arquivo com nome e legenda dele sobe ao
        // Storage). Desfecho de PRÉ-VOO (`cliente_nao_identificado`,
        // `sem_fatura_em_aberto`, credencial ausente, `lerLimiteDeCobranca`
        // lançando…) nunca chega a chamar isto — e continua re-tentável no
        // mesmo turno. Armar antes do `try` travava até esses casos: a
        // descrição da ferramenta manda chamá-la ANTES de escrever texto, e um
        // `cliente_nao_identificado` seguido de identificação + nova tentativa
        // — o caminho normal de um cliente que abre com "me manda o boleto" —
        // levava `cobranca_ja_tentada_no_turno` sem nunca ter enviado nada
        // (regressão da revisão de qualidade anterior).
        guardarArquivo: async (arquivo) => {
          estado.cobrancaTentadaNoTurno.valor = true;
          const caminho = `${p.tenantId}/${p.conversationId}/cobranca-${randomUUID().slice(0, 8)}/${arquivo.nome}.${arquivo.extensao}`;
          const { error } = await p.supabase.storage
            .from('whatsapp-media')
            .upload(caminho, arquivo.conteudo, { contentType: arquivo.mime, upsert: false });
          if (error) throw new Error(`storage: ${error.message}`);
          caminhoDoArquivo = caminho;
          return caminho;
        },
        enviar: async (mensagem) => {
          // Também arma aqui (e não só em `guardarArquivo`): a forma de
          // cobrança pode um dia não levar arquivo, e mesmo hoje é esta porta
          // que de fato alcança o cliente.
          estado.cobrancaTentadaNoTurno.valor = true;
          const envio = await p.saida.enviar(mensagem);
          if (!envio.ok) throw new VetoDaSaida(envio.code, envio.message);
          if (envio.outcome.kind === 'queued') houveQueued = true;
        },
      },
    });
    await voltouAoAr(p, conector, credencial.status);
    if (r.resultado !== 'enviada' && caminhoDoArquivo !== null) {
      await removerArquivoOrfao(p, caminhoDoArquivo);
    }
    return respostaDaCobranca(p, conector, r, limite, houveQueued);
  } catch (err) {
    if (caminhoDoArquivo !== null) await removerArquivoOrfao(p, caminhoDoArquivo);
    if (err instanceof VetoDaSaida) return { ok: false, error: { code: err.code, message: err.message } };
    return falha(p, conector, err, 'cobrar');
  }
}

function respostaDaCobranca(p: PedidoDeFerramentas, conector: ConectorDoTurno, r: ResultadoDaCobranca, limite: number, houveQueued: boolean): Resposta {
  switch (r.resultado) {
    case 'enviada': {
      // A mesma ação do botão, com o agente como ator. O id, a forma e o valor —
      // nunca a linha digitável nem o copia-e-cola.
      void audit({
        action: 'conector.fatura_enviada',
        organizationId: p.tenantId,
        resourceType: 'conversation',
        resourceId: p.conversationId,
        metadata: {
          conector: conector.id,
          fatura: r.auditoria.faturaId,
          forma: r.forma,
          vencimento: r.fatura.vencimento,
          valor_cents: r.fatura.valorCents,
          mensagens_enviadas: r.enviadas,
          mensagens_previstas: r.previstas,
          pix_gerado_agora: r.pixGeradoAgora,
          pix_indisponivel: r.pixIndisponivel,
          ...ator(p),
        },
      });
      if (r.enviadas < r.previstas) {
        return {
          ok: false,
          estado: 'enviada_em_parte',
          orientacao:
            `A cobrança saiu incompleta (${r.enviadas} de ${r.previstas} mensagens) — não dá para saber ` +
            'exatamente o que chegou ao cliente. Avise que pode faltar uma parte e transfira a conversa ' +
            'para uma pessoa.',
        };
      }
      if (houveQueued) {
        // Igual a `send_message` com `queued`: o canal ACEITOU, ainda não
        // ENTREGOU (sessão fora do ar) — dizer "enviada" aqui seria a IA
        // afirmar ao cliente uma entrega que ainda não aconteceu.
        return {
          ok: true,
          estado: 'aceita_aguardando_canal',
          forma: r.forma,
          fatura: faturaDoModelo(r.fatura),
          orientacao:
            'O canal aceitou a cobrança e vai entregá-la quando a sessão voltar. NÃO diga que já chegou ' +
            'ao cliente, e não chame esta ferramenta de novo agora.',
        };
      }
      return {
        ok: true,
        estado: 'enviada',
        forma: r.forma,
        fatura: faturaDoModelo(r.fatura),
        ...(r.pixIndisponivel ? { pix_indisponivel: true } : {}),
        orientacao:
          (r.pixIndisponivel ? 'O Pix não pôde ser gerado, então foi enviado o BOLETO desta fatura — conte isso ao cliente. ' : '') +
          'A cobrança foi enviada (arquivo + código para copiar). Não repita o código nem o valor em texto; se quiser, escreva no máximo uma frase curta.',
      };
    }
    case 'cliente_nao_identificado':
      return { ok: false, estado: r.resultado, orientacao: `O cliente desta conversa ainda não foi identificado. Chame ${FERRAMENTA_CONSULTAR_CLIENTE} primeiro.` };
    case 'sem_fatura_em_aberto':
      return { ok: false, estado: r.resultado, orientacao: 'Não há fatura em aberto para este cliente. Diga isso a ele.' };
    case 'fatura_ja_paga':
      // Ela fechou ENTRE listar e reler: quem acabou de pagar não vai para a Cobrança.
      return {
        ok: false,
        estado: r.resultado,
        fatura: faturaDoModelo(r.fatura),
        orientacao: 'Esta fatura foi paga (o sistema já a fechou). Agradeça o pagamento e não envie cobrança. Se o cliente insistir que há outra em aberto, chame esta ferramenta de novo.',
      };
    case 'encaminhar_para_cobranca': {
      void audit({
        action: 'conector.cobranca_encaminhada',
        organizationId: p.tenantId,
        resourceType: 'conversation',
        resourceId: p.conversationId,
        metadata: { conector: conector.id, fatura: r.auditoria.faturaId, dias_de_atraso: r.fatura.diasDeAtraso, limite_de_dias: limite, ...ator(p) },
      });
      return {
        ok: false,
        estado: r.resultado,
        fatura: faturaDoModelo(r.fatura),
        orientacao: `Esta fatura tem ${r.fatura.diasDeAtraso} dias de atraso, acima do limite de ${limite}: nada foi enviado. Diga que ela foi encaminhada ao setor de cobrança e ${TRANSFERIR_COBRANCA}.`,
      };
    }
    case 'boleto_indisponivel':
      return { ok: false, estado: r.resultado, fatura: faturaDoModelo(r.fatura), orientacao: 'O boleto desta fatura ainda não foi emitido. Ofereça o Pix; se o cliente aceitar, chame de novo com forma "pix".' };
    case 'sem_como_cobrar':
      return {
        ok: false,
        estado: r.resultado,
        fatura: faturaDoModelo(r.fatura),
        ...(r.detalheDoErp ? { resposta_do_sistema: r.detalheDoErp } : {}),
        // `motivoInterno` (quando existe) é falha NOSSA, não frase do ERP: vai ao log, nunca ao modelo.
        orientacao: `Não foi possível gerar a cobrança desta fatura agora. Diga que vai passar para o setor de cobrança e ${TRANSFERIR_COBRANCA} (a resposta do sistema vai no motivo da transferência, não para o cliente).`,
      };
  }
}
