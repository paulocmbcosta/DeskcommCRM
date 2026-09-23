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
 *   - a conversa, o contato e o canal vêm do closure do turno — o modelo nunca
 *     passa contato, conversa nem id de fatura;
 *   - as 3 tentativas de identificação por ATENDIMENTO, contadas pela auditoria;
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
import { identidadeDoTelefone } from '@/lib/channels/capabilities';
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

function indisponivel(): Resposta {
  return {
    ok: false,
    estado: 'sistema_indisponivel',
    orientacao:
      'Não consegui consultar o sistema de gestão agora. Diga isso ao cliente com naturalidade e ' +
      'transfira a conversa para uma pessoa — não invente situação, valor nem vencimento.',
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
      execute: ({ cpf_cnpj, data_nascimento }) => consultar(p, conector, cpf_cnpj, data_nascimento),
    });
  }
  if (pedidas.includes(FERRAMENTA_ENVIAR_COBRANCA)) {
    tools[FERRAMENTA_ENVIAR_COBRANCA] = tool({
      description: DESCRICAO_ENVIAR_COBRANCA,
      inputSchema: z
        .object({ forma: z.string().optional().describe('"pix" (padrão) ou "boleto" — boleto só se o cliente pedir') })
        .passthrough(),
      execute: ({ forma }) => enviarCobranca(p, conector, forma),
    });
  }
  return { tools, ausentes: [] };
}

async function conversa(p: PedidoDeFerramentas): Promise<{ telefone: string | null; identidadeDoTelefone: ReturnType<typeof identidadeDoTelefone> }> {
  const { rows } = await p.pool.query<{ phone_number: string | null; provider: string | null }>(
    `select c.phone_number, s.provider
       from contacts c
       left join channel_sessions s on s.id = $3 and s.organization_id = c.organization_id
      where c.organization_id = $1 and c.id = $2`,
    [p.tenantId, p.leadId, p.channelSessionId],
  );
  return { telefone: rows[0]?.phone_number ?? null, identidadeDoTelefone: identidadeDoTelefone(rows[0]?.provider) };
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

const ator = (p: PedidoDeFerramentas) => ({ ator: 'ai_agent', agente_id: p.agentId });

async function falha(p: PedidoDeFerramentas, conector: ConectorDoTurno, err: unknown): Promise<Resposta> {
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
  } else {
    p.log.error('ferramenta do conector falhou', {
      conector: conector.id,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
  }
  return indisponivel();
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
  cpfCnpj: string | undefined,
  dataNascimento: string | undefined,
): Promise<Resposta> {
  try {
    const credencial = await lerCredencial(p.supabase, p.tenantId, conector.id);
    if (!credencial) return indisponivel();
    const cpf = cpfCnpj?.trim() || undefined;
    const nascimento = dataNascimento?.trim() || undefined;
    if ((cpf || nascimento) && (await recusasNoAtendimento(p)) >= TENTATIVAS_DE_IDENTIFICACAO) return esgotadas();
    const c = await conversa(p);
    const r = await conector.agente.consultar({
      admin: p.supabase,
      credencial,
      orgId: p.tenantId,
      contactId: p.leadId,
      telefone: c.telefone,
      identidadeDoTelefone: c.identidadeDoTelefone,
      ...(cpf ? { cpfCnpj: cpf } : {}),
      ...(nascimento ? { dataNascimento: nascimento } : {}),
      agora: p.agora(),
    });
    await voltouAoAr(p, conector, credencial.status);
    return await respostaDaConsulta(p, conector, r);
  } catch (err) {
    return falha(p, conector, err);
  }
}

function orientacaoDaConsulta(r: Extract<ResultadoDaConsulta, { estado: 'identificado' }>, limite: number): string {
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
    partes.push(
      `Para cobrar, use ${FERRAMENTA_ENVIAR_COBRANCA}: ela envia só a fatura da vez, por Pix, a menos que ` +
        'o cliente peça boleto. Não prometa enviar mais de uma fatura.',
    );
  } else if (r.financeiro) {
    partes.push('Não há fatura em aberto.');
  } else {
    partes.push('O financeiro não pôde ser lido agora: não afirme valores nem vencimentos.');
  }
  return partes.join(' ');
}

async function respostaDaConsulta(p: PedidoDeFerramentas, conector: ConectorDoTurno, r: ResultadoDaConsulta): Promise<Resposta> {
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
        orientacao: orientacaoDaConsulta(r, limite),
      };
    }
    case 'precisa_cpf':
      return { ok: false, estado: r.estado, orientacao: 'Este telefone está em mais de um cadastro. Peça o CPF (ou CNPJ) do titular e chame de novo com cpf_cnpj.' };
    case 'precisa_cpf_e_nascimento':
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
      // AGUARDADA: é o contador das tentativas, não telemetria. Sem CPF nem data no metadata.
      await audit({
        action: 'conector.identificacao_recusada',
        organizationId: p.tenantId,
        resourceType: 'conversation',
        resourceId: p.conversationId,
        metadata: { conector: conector.id, ...ator(p) },
      });
      const restantes = Math.max(0, TENTATIVAS_DE_IDENTIFICACAO - (await recusasNoAtendimento(p)));
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

async function enviarCobranca(p: PedidoDeFerramentas, conector: ConectorDoTurno, formaBruta: string | undefined): Promise<Resposta> {
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
  try {
    const credencial = await lerCredencial(p.supabase, p.tenantId, conector.id);
    if (!credencial) return indisponivel();
    const c = await conversa(p);
    const limite = await lerLimiteDeCobranca(p.supabase, p.tenantId, conector.id);
    const r = await conector.agente.enviarCobranca({
      admin: p.supabase,
      credencial,
      orgId: p.tenantId,
      contactId: p.leadId,
      identidadeDoTelefone: c.identidadeDoTelefone,
      forma,
      limiteDeDias: limite,
      agora: p.agora(),
      portas: {
        // Storage-first, no prefixo que o handler de envio confere (`<org>/<conversa>/…`).
        // O ÚLTIMO segmento é o nome que o cliente vê — igual à rota do botão.
        guardarArquivo: async (arquivo) => {
          const caminho = `${p.tenantId}/${p.conversationId}/cobranca-${randomUUID().slice(0, 8)}/${arquivo.nome}.${arquivo.extensao}`;
          const { error } = await p.supabase.storage
            .from('whatsapp-media')
            .upload(caminho, arquivo.conteudo, { contentType: arquivo.mime, upsert: false });
          if (error) throw new Error(`storage: ${error.message}`);
          return caminho;
        },
        enviar: async (mensagem) => {
          const envio = await p.saida.enviar(mensagem);
          if (!envio.ok) throw new VetoDaSaida(envio.code, envio.message);
        },
      },
    });
    await voltouAoAr(p, conector, credencial.status);
    return respostaDaCobranca(p, conector, r, limite);
  } catch (err) {
    if (err instanceof VetoDaSaida) return { ok: false, error: { code: err.code, message: err.message } };
    return falha(p, conector, err);
  }
}

function respostaDaCobranca(p: PedidoDeFerramentas, conector: ConectorDoTurno, r: ResultadoDaCobranca, limite: number): Resposta {
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
        return { ok: false, estado: 'enviada_em_parte', orientacao: 'Só o arquivo da cobrança saiu; o código para copiar não. Avise o cliente e transfira a conversa para uma pessoa.' };
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
