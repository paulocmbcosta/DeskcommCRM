/**
 * O RESUMO DO CLIENTE — tudo o que o atendente abriria o IXC para ver, numa
 * resposta só.
 *
 * DUAS ONDAS, porque cada chamada ao IXC custa ~1,4 s (medido) e em série o
 * painel levaria dez segundos: a primeira dispara as seis leituras que só
 * dependem do id do cliente; a segunda busca o sinal da ONU, que depende do id
 * do LOGIN.
 *
 * FALHA É POR SEÇÃO. O `crm-summary` do painel vizinho falha inteiro de
 * propósito (um pedido, um veredito) porque lá as três consultas são do MESMO
 * banco e falham juntas. Aqui o outro lado é um ERP de terceiro: a tabela de OS
 * pode estar fora do escopo do token enquanto o financeiro responde, e esconder
 * a fatura vencida porque a OS não veio deixaria o atendente pior do que sem
 * painel. Só o cadastro do cliente é obrigatório — sem ele não há de quem falar.
 */
import type { CredencialDeConector, MotivoDeFalha } from "../tipos";
import { FalhaDoConector } from "../tipos";
import {
  CAMPOS_DA_FATURA,
  CAMPOS_DA_FIBRA,
  CAMPOS_DA_OS,
  CAMPOS_DO_CONTRATO,
  CAMPOS_DO_LOGIN,
  CAMPOS_DO_TICKET,
} from "./campos";
import { hojeEmSaoPaulo, recortarFaturas, type RecorteDeFaturas } from "./faturas";
import { listarNoIxc, type Listagem } from "./http";
import { clientePorId, type ClienteIxc } from "./identificar";
import {
  acessoBloqueado,
  lerConexao,
  lerPrioridade,
  lerSinalRx,
  lerStatusDaOs,
  lerStatusDoAcesso,
  lerStatusDoContrato,
  lerStatusDoTicket,
  type Leitura,
} from "./vocabulario";

export type Secao<T> = { ok: true; dados: T } | { ok: false; motivo: MotivoDeFalha };

export interface ContratoIxc {
  id: string;
  plano: string;
  status: Leitura;
  acesso: Leitura;
  vigente: boolean;
  bloqueado: boolean;
  /**
   * O `status_internet` CRU. O painel não precisa dele (já tem `acesso` e
   * `bloqueado`); quem precisa é a projeção da IA (`clienteDe`, em
   * `lib/conectores/ixc/agente.ts`), pra distinguir "vocabulário conhece como
   * liberado" de "código que esta imagem nunca viu" — ver `acessoLiberado` em
   * `vocabulario.ts`.
   */
  statusInternet: string;
  ativadoEm: string;
  endereco: string;
  parcelasEmAtraso: number;
  desbloqueioDeConfiancaAtivo: boolean;
}

export interface SinalDaOnu {
  rx: Leitura & { dbm: number | null };
  txDbm: number | null;
  lidoEm: string;
  temperatura: string;
  distanciaMetros: string;
  causaDaUltimaQueda: string;
}

export interface ConexaoIxc {
  id: string;
  idContrato: string;
  login: string;
  estado: Leitura;
  ip: string;
  mac: string;
  conectouEm: string;
  caiuEm: string;
  motivoDaDesconexao: string;
  /** `null` = login sem ONU cadastrada (rádio, cabo) ou leitura indisponível. */
  sinal: SinalDaOnu | null;
}

export interface OsIxc {
  id: string;
  protocolo: string;
  status: Leitura;
  prioridade: Leitura;
  abertaEm: string;
  agendadaPara: string;
  resumo: string;
}

export interface AtendimentoIxc {
  id: string;
  protocolo: string;
  titulo: string;
  status: Leitura;
  criadoEm: string;
}

export interface ResumoIxc {
  cliente: ClienteIxc;
  /** A frase do topo: bloqueado, liberado, ou sem contrato vigente. */
  situacao: Leitura;
  contratos: Secao<ContratoIxc[]>;
  financeiro: Secao<RecorteDeFaturas>;
  conexoes: Secao<ConexaoIxc[]>;
  ordensDeServico: Secao<{ abertas: OsIxc[]; total: number }>;
  atendimentos: Secao<{ abertos: AtendimentoIxc[]; total: number }>;
  lidoEm: string;
}

const TETO_DE_CONTRATOS = 5;
const TETO_DE_LOGINS = 3;
const TETO_DE_ITENS = 10;

/** O IXC usa `0000-00-00 00:00:00` como "nunca". Para a tela isso é vazio. */
function data(bruta: string | undefined): string {
  const v = (bruta ?? "").trim();
  return v.startsWith("0000") ? "" : v;
}

function cortar(texto: string | undefined, teto: number): string {
  const limpo = (texto ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return limpo.length > teto ? `${limpo.slice(0, teto - 1)}…` : limpo;
}

function numero(bruto: string | undefined): number | null {
  const n = Number.parseFloat(bruto ?? "");
  return Number.isFinite(n) ? n : null;
}

function secao<T>(resultado: PromiseSettledResult<Listagem>, montar: (l: Listagem) => T): Secao<T> {
  if (resultado.status === "fulfilled") return { ok: true, dados: montar(resultado.value) };
  const motivo = resultado.reason instanceof FalhaDoConector ? resultado.reason.motivo : "resposta_inesperada";
  return { ok: false, motivo };
}

function lerContrato(r: Record<string, string>): ContratoIxc {
  const status = r.status ?? "";
  const statusInternet = r.status_internet ?? "";
  return {
    id: r.id ?? "",
    plano: (r.contrato ?? "").trim(),
    status: lerStatusDoContrato(status),
    acesso: lerStatusDoAcesso(statusInternet),
    vigente: status === "A",
    bloqueado: acessoBloqueado(statusInternet),
    statusInternet,
    ativadoEm: data(r.data_ativacao),
    endereco: [[r.endereco, r.numero].filter(Boolean).join(", "), r.bairro].filter(Boolean).join(" — "),
    parcelasEmAtraso: Number.parseInt(r.num_parcelas_atraso ?? "", 10) || 0,
    desbloqueioDeConfiancaAtivo: r.desbloqueio_confianca_ativo === "S",
  };
}

/**
 * Bloqueio só conta em contrato VIGENTE: contrato cancelado em 2022 com
 * `status_internet = CA` não é "cliente bloqueado", é história.
 */
export function situacaoDoCliente(contratos: ContratoIxc[]): Leitura {
  const vigentes = contratos.filter((c) => c.vigente);
  if (vigentes.length === 0) return { rotulo: "Sem contrato ativo", tom: "neutro" };
  const bloqueado = vigentes.find((c) => c.bloqueado);
  if (bloqueado) return { rotulo: bloqueado.acesso.rotulo, tom: "ruim", detalhe: bloqueado.acesso.detalhe };
  return { rotulo: "Liberado", tom: "bom" };
}

export async function montarResumo(
  credencial: CredencialDeConector,
  idDoCliente: string,
  agora: Date = new Date(),
): Promise<ResumoIxc | null> {
  const porCliente = (tabela: string) => ({ campo: `${tabela}.id_cliente`, operador: "=" as const, valor: idDoCliente });

  const [cliente, contratos, faturas, logins, os, tickets] = await Promise.allSettled([
    clientePorId(credencial, idDoCliente),
    listarNoIxc(credencial, {
      tabela: "cliente_contrato",
      filtro: porCliente("cliente_contrato"),
      campos: CAMPOS_DO_CONTRATO,
      limite: 20,
    }),
    listarNoIxc(credencial, {
      tabela: "fn_areceber",
      filtro: porCliente("fn_areceber"),
      tambem: [{ campo: "fn_areceber.status", operador: "=", valor: "A" }],
      campos: CAMPOS_DA_FATURA,
      limite: 50,
      ordenarPor: "fn_areceber.data_vencimento",
      ordem: "asc",
    }),
    listarNoIxc(credencial, {
      tabela: "radusuarios",
      filtro: porCliente("radusuarios"),
      campos: CAMPOS_DO_LOGIN,
      limite: 20,
    }),
    listarNoIxc(credencial, {
      tabela: "su_oss_chamado",
      filtro: porCliente("su_oss_chamado"),
      tambem: [{ campo: "su_oss_chamado.status", operador: "!=", valor: "F" }],
      campos: CAMPOS_DA_OS,
      limite: TETO_DE_ITENS,
    }),
    listarNoIxc(credencial, {
      tabela: "su_ticket",
      filtro: porCliente("su_ticket"),
      tambem: [
        { campo: "su_ticket.su_status", operador: "!=", valor: "S" },
        { campo: "su_ticket.su_status", operador: "!=", valor: "C" },
      ],
      campos: CAMPOS_DO_TICKET,
      limite: TETO_DE_ITENS,
    }),
  ]);

  // Sem o cadastro não há painel: a falha dele SOBE, com o motivo que ela tem.
  if (cliente.status === "rejected") throw cliente.reason;
  if (!cliente.value) return null;

  const secaoDeContratos = secao(contratos, (l) =>
    l.registros
      .map(lerContrato)
      .sort((a, b) => Number(b.vigente) - Number(a.vigente))
      .slice(0, TETO_DE_CONTRATOS),
  );

  const loginsLidos =
    logins.status === "fulfilled"
      ? logins.value.registros
          .filter((r) => r.id)
          .sort((a, b) => Number(b.ativo === "S") - Number(a.ativo === "S"))
          .slice(0, TETO_DE_LOGINS)
      : [];

  // ONDA 2 — o sinal, por login. Falha aqui não derruba a conexão: login sem
  // leitura de ONU é o caso NORMAL de quem não é fibra.
  const sinais = await Promise.allSettled(
    loginsLidos.map((l) =>
      listarNoIxc(credencial, {
        tabela: "radpop_radio_cliente_fibra",
        filtro: { campo: "radpop_radio_cliente_fibra.id_login", operador: "=", valor: l.id ?? "" },
        campos: CAMPOS_DA_FIBRA,
        limite: 1,
      }),
    ),
  );

  const secaoDeConexoes: Secao<ConexaoIxc[]> =
    logins.status === "rejected"
      ? secao(logins, () => [])
      : {
          ok: true,
          dados: loginsLidos.map((l, i) => {
            const leitura = sinais[i];
            const fibra = leitura?.status === "fulfilled" ? leitura.value.registros[0] : undefined;
            return {
              id: l.id ?? "",
              idContrato: l.id_contrato ?? "",
              login: l.login ?? "",
              estado: l.ativo === "N" ? { rotulo: "Login desativado", tom: "neutro" as const } : lerConexao(l.online ?? ""),
              ip: l.ip ?? "",
              mac: l.mac ?? "",
              conectouEm: data(l.ultima_conexao_inicial),
              caiuEm: data(l.ultima_conexao_final),
              motivoDaDesconexao: cortar(l.motivo_desconexao, 80),
              sinal: fibra
                ? {
                    rx: lerSinalRx(fibra.sinal_rx ?? ""),
                    txDbm: numero(fibra.sinal_tx),
                    lidoEm: data(fibra.data_sinal),
                    temperatura: fibra.temperatura ?? "",
                    distanciaMetros: fibra.distancia_onu ?? "",
                    causaDaUltimaQueda: cortar(fibra.causa_ultima_queda, 80),
                  }
                : null,
            };
          }),
        };

  return {
    cliente: cliente.value,
    situacao: secaoDeContratos.ok ? situacaoDoCliente(secaoDeContratos.dados) : { rotulo: "—", tom: "neutro" },
    contratos: secaoDeContratos,
    financeiro: secao(faturas, (l) => recortarFaturas(l.registros, hojeEmSaoPaulo(agora))),
    conexoes: secaoDeConexoes,
    ordensDeServico: secao(os, (l) => ({
      total: l.total,
      abertas: l.registros.map((r) => ({
        id: r.id ?? "",
        protocolo: r.protocolo ?? "",
        status: lerStatusDaOs(r.status ?? ""),
        prioridade: lerPrioridade(r.prioridade ?? ""),
        abertaEm: data(r.data_abertura),
        agendadaPara: data(r.data_agenda),
        resumo: cortar(r.mensagem, 160),
      })),
    })),
    atendimentos: secao(tickets, (l) => ({
      total: l.total,
      abertos: l.registros.map((r) => ({
        id: r.id ?? "",
        protocolo: r.protocolo ?? "",
        titulo: cortar(r.titulo, 120),
        status: lerStatusDoTicket(r.su_status ?? ""),
        criadoEm: data(r.data_criacao),
      })),
    })),
    lidoEm: agora.toISOString(),
  };
}
