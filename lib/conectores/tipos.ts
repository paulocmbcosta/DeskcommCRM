/**
 * CONECTORES — o contrato que o núcleo conhece.
 *
 * Um conector liga UMA organização a UM sistema externo (hoje: o IXC, ERP de
 * provedor de internet). O produto é um só para todo cliente, então o núcleo não
 * pode saber o que é IXC: ele conhece este arquivo e o `registro.ts`, e pergunta
 * "quais conectores esta organização ligou". Mesmo desenho de `lib/channels/`
 * (docs/doctrine/restricao-de-canal.md), e pela mesma razão.
 *
 * Os três vocabulários abaixo espelham CHECKs do banco (migration 0271) e são
 * medidos por tests/invariants/vocabulario-banco-x-typescript.test.ts — conector
 * novo é uma linha aqui E uma migration que estende o CHECK.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { IdentidadeDoTelefone } from "@/lib/channels/capabilities";
export const IDS_DE_CONECTOR = ["ixc"] as const;
export type ConectorId = (typeof IDS_DE_CONECTOR)[number];

export const ESTADOS_DA_CONEXAO = ["ativa", "erro"] as const;
export type EstadoDaConexao = (typeof ESTADOS_DA_CONEXAO)[number];

export const FORMAS_DE_VERIFICACAO = ["telefone", "documento", "manual"] as const;
export type FormaDeVerificacao = (typeof FORMAS_DE_VERIFICACAO)[number];

/** Como a cobrança sai: o PDF do boleto ou o Pix. Vocabulário do produto, não do ERP. */
export const FORMAS_DE_COBRANCA = ["boleto", "pix"] as const;
export type FormaDeCobranca = (typeof FORMAS_DE_COBRANCA)[number];

export function ehConectorId(valor: string): valor is ConectorId {
  return (IDS_DE_CONECTOR as readonly string[]).includes(valor);
}

/** Host + token em claro. Vive só no escopo de uma chamada — nunca em log nem resposta. */
export interface CredencialDeConector {
  baseUrl: string;
  token: string;
}

/**
 * Por que a chamada ao sistema externo falhou — em termos que a TELA consegue
 * transformar em conserto. "Deu erro" não é diagnóstico: `credencial_recusada`
 * manda trocar o token, `sem_resposta` manda conferir o endereço.
 */
export type MotivoDeFalha =
  | "url_insegura"
  | "sem_resposta"
  | "credencial_recusada"
  | "recurso_indisponivel"
  | "resposta_inesperada";

export class FalhaDoConector extends Error {
  constructor(
    public readonly motivo: MotivoDeFalha,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "FalhaDoConector";
  }
}

export type ResultadoDoTeste = { ok: true } | { ok: false; motivo: MotivoDeFalha; detalhe: string };

// ─── O que o AGENTE DE IA faz com um conector ────────────────────────────────
//
// O motor conhece ESTES tipos e o registro — nunca a pasta de um conector. Os
// nomes falam de cliente, situação, fatura e forma, não de `fn_areceber`.
// Spec: docs/superpowers/specs/2026-09-22-ia-envia-cobranca-ixc-design.md.

/** Um arquivo que a cobrança leva: o PDF do boleto, o PNG do QR do Pix. */
export interface ArquivoDaCobranca {
  /** Sem extensão e sem caminho: `boleto-10-09-2026`. Quem guarda decide onde. */
  nome: string;
  extensao: "pdf" | "png";
  mime: "application/pdf" | "image/png";
  conteudo: Buffer;
}

export interface MensagemDaCobranca {
  type: "text" | "document" | "image";
  body: string;
  media_storage_path?: string;
  media_mime?: string;
  media_size_bytes?: number;
}

export interface PortasDoEnvio {
  /** Sobe o arquivo (storage-first) e devolve o caminho que `enviar` vai citar. */
  guardarArquivo(arquivo: ArquivoDaCobranca): Promise<string>;
  /** Envia UMA mensagem na conversa — a saída de sempre: fila, anti-banimento, opt-out. */
  enviar(mensagem: MensagemDaCobranca): Promise<void>;
}

export interface FaturaParaAgente {
  /** `AAAA-MM-DD`. */
  vencimento: string;
  valorCents: number;
  /** 0 quando ainda não venceu. */
  diasDeAtraso: number;
}

export interface FinanceiroParaAgente {
  vencidas: FaturaParaAgente[];
  proxima: FaturaParaAgente | null;
  totalVencidoCents: number;
  /** A ÚNICA fatura que se cobra agora (regra do dono, 22/09). */
  daVez: FaturaParaAgente | null;
}

/** O que a IA pode saber do cliente (decisão de 21/09). `null` = a seção não pôde ser lida. */
export interface ClienteParaAgente {
  primeiroNome: string;
  situacao: string | null;
  motivoDaSituacao: string | null;
  bloqueado: boolean | null;
  plano: string | null;
  /** `AAAA-MM-DD` do contrato em vigor mais antigo. */
  clienteDesde: string | null;
  conexao: "online" | "offline" | "sem_informacao" | null;
  temOsAberta: boolean | null;
}

export interface PedidoDeConsulta {
  admin: SupabaseClient;
  credencial: CredencialDeConector;
  orgId: string;
  contactId: string;
  telefone: string | null;
  /**
   * O telefone é identidade no canal desta conversa (`lib/channels/capabilities.ts`).
   * "desconhecido" (canal ilegível, provider que esta imagem não conhece) NÃO é "nao":
   * ele bloqueia vincular pelo telefone, mas não descarta vínculo que já existe.
   */
  identidadeDoTelefone: IdentidadeDoTelefone;
  cpfCnpj?: string;
  dataNascimento?: string;
  agora?: Date;
}

/**
 * O que uma consulta grava na AUDITORIA — o motor NUNCA repassa isto ao modelo.
 * Agrupado à parte (em vez de campo solto ao lado de `cliente`/`financeiro`)
 * de propósito: quem monta o contexto da IA a partir de `ResultadoDaConsulta`
 * tem de tirar `auditoria` de propósito, nunca espalhar o objeto inteiro sem
 * pensar — um `...resultado` desavisado não vaza `auditoria` pra dentro da
 * mensagem do jeito que vazaria um campo solto.
 */
export interface AuditoriaDaConsulta {
  /** Presente quando ESTA consulta criou OU promoveu o vínculo. */
  vinculou?: { verificadoPor: FormaDeVerificacao; cadastros: string[] };
}

export type ResultadoDaConsulta =
  | {
      estado: "identificado";
      cliente: ClienteParaAgente;
      /** `null` quando o financeiro não pôde ser lido. */
      financeiro: FinanceiroParaAgente | null;
      auditoria: AuditoriaDaConsulta;
    }
  | {
      estado: "precisa_cpf" | "precisa_cpf_e_nascimento" | "cpf_invalido" | "data_invalida" | "nao_conferiu";
      /**
       * Só em `nao_conferiu`: o CPF existe no sistema, mas a data de nascimento do
       * cadastro está num formato que esta imagem não lê. O CLIENTE recebe a mesma
       * recusa de sempre (não se diz qual dado falhou); quem precisa saber é o LOG do
       * turno — sem isto, um ERP que grave a data de outro jeito faria 100% das
       * conferências recusarem em silêncio, queimando as 3 tentativas de todo mundo.
       */
      dataIlegivel?: true;
    };

export interface PedidoDeCobranca {
  admin: SupabaseClient;
  credencial: CredencialDeConector;
  orgId: string;
  contactId: string;
  identidadeDoTelefone: IdentidadeDoTelefone;
  forma: FormaDeCobranca;
  /** Fatura com MAIS dias de atraso que isto não é enviada: vai para a Cobrança. */
  limiteDeDias: number;
  portas: PortasDoEnvio;
  agora?: Date;
}

/**
 * O que um envio grava na AUDITORIA — o motor NUNCA repassa isto ao modelo.
 * Mesmo racional de `AuditoriaDaConsulta`: agrupado à parte pra um
 * `...resultado` desavisado não espalhar `faturaId`/`motivoInterno` pro modelo.
 */
export interface AuditoriaDaCobranca {
  faturaId: string;
  /**
   * Só quando a falha é NOSSA — a fatura nem foi achada na releitura
   * (`fatura_nao_encontrada`). NUNCA é a frase do IXC: essa é `detalheDoErp`,
   * ao lado, e essa sim pode valer a pena um humano ver no log da Cobrança.
   */
  motivoInterno?: string;
}

export type ResultadoDaCobranca =
  | {
      resultado: "enviada";
      forma: FormaDeCobranca;
      fatura: FaturaParaAgente;
      enviadas: number;
      previstas: number;
      pixGeradoAgora: boolean;
      /** O Pix falhou e saiu o BOLETO da mesma fatura no lugar. */
      pixIndisponivel: boolean;
      auditoria: AuditoriaDaCobranca;
    }
  | { resultado: "cliente_nao_identificado" | "sem_fatura_em_aberto" }
  | {
      /** `fatura_ja_paga`: a fatura fechou ENTRE listar e reler — quem pagou não vira "encaminhar pra Cobrança". */
      resultado: "encaminhar_para_cobranca" | "boleto_indisponivel" | "fatura_ja_paga";
      fatura: FaturaParaAgente;
      auditoria: AuditoriaDaCobranca;
    }
  | { resultado: "sem_como_cobrar"; fatura: FaturaParaAgente; detalheDoErp?: string; auditoria: AuditoriaDaCobranca };

export interface CapacidadeDoAgente {
  consultar(p: PedidoDeConsulta): Promise<ResultadoDaConsulta>;
  enviarCobranca(p: PedidoDeCobranca): Promise<ResultadoDaCobranca>;
}

/** O que o núcleo sabe de um conector sem conhecer o sistema do outro lado. */
export interface DefinicaoDeConector {
  id: ConectorId;
  /** Nome na aba do painel e na tela de configuração. */
  rotulo: string;
  descricao: string;
  /** Texto de ajuda do campo de endereço — cada sistema tem o seu formato de host. */
  ajudaDoEndereco: string;
  ajudaDoToken: string;
  /** Prova host + token com uma leitura mínima. NUNCA lança: devolve veredito. */
  testar(credencial: CredencialDeConector): Promise<ResultadoDoTeste>;
  /**
   * O que o agente de IA faz com este conector (identificar, cobrar). Ausente =
   * o conector não tem cobrança, e as ferramentas dele não entram no turno.
   */
  agente?: CapacidadeDoAgente;
}

/** A frase que a tela mostra para cada motivo. Uma só fonte, três telas. */
export const FRASE_DA_FALHA: Record<MotivoDeFalha, string> = {
  url_insegura: "O endereço não é aceito. Use o endereço público do sistema, começando com https://.",
  sem_resposta: "O sistema não respondeu. Confira o endereço e se ele está no ar.",
  credencial_recusada: "O sistema recusou o token. Confira se ele está certo e ativo.",
  recurso_indisponivel: "O token não tem acesso a um dos dados que o painel usa.",
  resposta_inesperada: "O sistema respondeu de um jeito que não entendi.",
};
