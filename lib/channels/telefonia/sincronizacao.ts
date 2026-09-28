/**
 * O CRM é a fonte da verdade dos números; o Asterisk guarda cópia em memória
 * (spec 20 §4.1). Este módulo faz a cópia bater com o banco.
 *
 * Três caminhos, do mais rápido ao mais garantido:
 *   1. a rota da API empurra o tronco na hora em que ele é salvo (`empurrarTronco`);
 *   2. o worker reconcilia a cada minuto (`SincronizadorDeTroncos.sincronizar`),
 *      pegando o que o caminho 1 perdeu (Asterisk fora do ar no momento, rota
 *      que caiu no meio);
 *   3. a cada reconexão à ARI, sincronização completa — Asterisk reiniciado
 *      volta com a memória vazia.
 */
import { createHash } from "node:crypto";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { type ClienteAri } from "./ari";
import { lerRegistros } from "./ami";
import {
  ORDEM_DE_GRAVACAO,
  idDoTronco,
  objetosDoTronco,
  problemaDoTronco,
  type ProblemaDoTronco,
  type TroncoSip,
} from "./pjsip";
import { gravarEstadoDoTronco, troncosAtivos, type TroncoDoBanco } from "./repositorio";
import type { Registro } from "./controle";

/** O tronco do banco não passa na régua de `conta-sip.ts` e não vai para o Asterisk. */
export class TroncoInvalido extends Error {
  constructor(readonly motivo: ProblemaDoTronco) {
    super(`tronco_invalido:${motivo}`);
    this.name = "TroncoInvalido";
  }
}

/** O que a tela mostra no número recusado aqui (`channel_sessions.status_reason`). */
export const MOTIVO_CONFIGURACAO_INVALIDA = "configuracao_invalida";

export async function empurrarTronco(ari: ClienteAri, t: TroncoSip): Promise<void> {
  // Antes de QUALQUER chamada à ARI — nem o `retirarTronco` abaixo roda: um
  // valor que não passa na régua não chega a virar campo PJSIP (uma vírgula no
  // servidor viraria um segundo contato na AOR).
  const problema = problemaDoTronco(t);
  if (problema) throw new TroncoInvalido(problema);
  // RECRIA, não atualiza: um registro de saída que só recebe PUT por cima troca
  // a configuração e continua registrando com a antiga — medido na prova pela
  // tela: o número editado para TCP seguiu mandando REGISTER por UDP, e uma
  // senha corrigida pela tela não teria efeito até o Asterisk reiniciar.
  // Apagar antes custa um REGISTER de saída (expires=0) e só acontece quando o
  // tronco MUDOU (o sincronizador compara o hash) ou é novo (404, sem efeito).
  await retirarTronco(ari, t.id);
  const objetos = objetosDoTronco(t);
  for (const tipo of ORDEM_DE_GRAVACAO) {
    for (const o of objetos.filter((x) => x.tipo === tipo)) await ari.gravarObjeto(o.tipo, o.id, o.campos);
  }
}

export async function retirarTronco(ari: ClienteAri, troncoId: string): Promise<void> {
  const id = idDoTronco(troncoId);
  for (const tipo of [...ORDEM_DE_GRAVACAO].reverse()) await ari.apagarObjeto(tipo, id);
}

/** Tradução do estado do registro para o que a linha do canal guarda (e a tela mostra). */
export function estadoParaCanal(
  estado: string | undefined,
  desdeOEnvioMs: number,
): { status: "STARTING" | "WORKING" | "FAILED"; motivo: string | null } {
  if (estado === "Registered") return { status: "WORKING", motivo: null };
  if (estado === "Rejected") return { status: "FAILED", motivo: "registro_recusado" };
  // Sem resposta ainda: dá um minuto antes de chamar de falha — o primeiro
  // REGISTER, o 401 e o reenvio autenticado levam segundos, não um instante.
  if (desdeOEnvioMs < 60_000) return { status: "STARTING", motivo: null };
  return { status: "FAILED", motivo: "sem_resposta_da_operadora" };
}

const hashDe = (t: TroncoSip) => createHash("sha256").update(JSON.stringify(objetosDoTronco(t))).digest("hex");

export class SincronizadorDeTroncos {
  private readonly enviados = new Map<string, { hash: string; em: number }>();

  constructor(
    private readonly ari: ClienteAri,
    private readonly db: Queryable,
    private readonly log: Registro,
    private readonly ami: { host: string; senha: string },
  ) {}

  /** `completa`: esquece o que acha que enviou (Asterisk pode ter reiniciado). */
  async sincronizar(completa = false): Promise<void> {
    if (completa) this.enviados.clear();
    const { troncos: lidos, ilegiveis } = await troncosAtivos(this.db);
    // A linha do banco é gravável pela REST, fora do Zod da rota: o que não
    // passa na régua dela não é empurrado, e fica FORA de `ativos` — então, se
    // uma versão válida anterior ainda estiver no Asterisk, a varredura de sobras
    // abaixo a retira. O banco é a fonte da verdade; seguir registrando com a
    // configuração velha faria a ligação chegar enquanto a tela diz "Falhou".
    const troncos: TroncoDoBanco[] = [];
    for (const t of lidos) {
      const problema = problemaDoTronco(t);
      if (!problema) {
        troncos.push(t);
        continue;
      }
      const mudou = await gravarEstadoDoTronco(this.db, t.id, "FAILED", MOTIVO_CONFIGURACAO_INVALIDA);
      // Só na transição: a reconciliação roda a cada minuto, e um aviso por
      // minuto por número inválido afogaria o log que alguém precisa ler.
      if (mudou) this.log.warn("telefonia: tronco com configuração inválida não enviado", { tronco: t.id, problema });
    }
    const ativos = new Set(troncos.map((t) => t.id));

    for (const t of troncos) {
      const hash = hashDe(t);
      if (this.enviados.get(t.id)?.hash === hash) continue;
      try {
        await empurrarTronco(this.ari, t);
        this.enviados.set(t.id, { hash, em: Date.now() });
        this.log.info("telefonia: tronco enviado ao Asterisk", { tronco: t.id });
      } catch (e) {
        this.log.warn("telefonia: tronco não enviado", { tronco: t.id, erro: String(e).slice(0, 200) });
      }
    }
    for (const id of ilegiveis) {
      await gravarEstadoDoTronco(this.db, id, "FAILED", "senha_ilegivel");
    }

    // O que o Asterisk tem e o banco não quer mais: número removido, arquivado,
    // ou que ficou de uma instalação anterior. A lista vem da própria AMI — o
    // mapa em memória não sobrevive a um reinício do worker.
    const noAsterisk = await this.registrosNoAsterisk();
    const sobras = new Set<string>([...this.enviados.keys()].filter((id) => !ativos.has(id)));
    for (const r of noAsterisk) {
      const id = r.objeto.startsWith("tronco-") ? r.objeto.slice("tronco-".length) : null;
      if (id && !ativos.has(id)) sobras.add(id);
    }
    for (const id of sobras) {
      try {
        await retirarTronco(this.ari, id);
        this.enviados.delete(id);
        this.log.info("telefonia: tronco retirado do Asterisk", { tronco: id });
      } catch (e) {
        this.log.warn("telefonia: tronco não retirado", { tronco: id, erro: String(e).slice(0, 200) });
      }
    }
  }

  private async registrosNoAsterisk() {
    try {
      return await lerRegistros({ host: this.ami.host, senha: this.ami.senha });
    } catch (e) {
      this.log.warn("telefonia: AMI sem resposta", { erro: String(e).slice(0, 160) });
      return [];
    }
  }

  /** Espelha o estado de cada registro na linha do canal. */
  async atualizarEstados(): Promise<void> {
    const regs = await this.registrosNoAsterisk();
    const porTronco = new Map(regs.map((r) => [r.objeto, r.estado]));
    for (const [id, env] of this.enviados) {
      const { status, motivo } = estadoParaCanal(porTronco.get(idDoTronco(id)), Date.now() - env.em);
      const mudou = await gravarEstadoDoTronco(this.db, id, status, motivo);
      if (mudou) this.log.info("telefonia: estado do número mudou", { tronco: id, status, motivo });
    }
  }
}
