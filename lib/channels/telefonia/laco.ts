/**
 * O laço da telefonia no worker: conecta na ARI, sincroniza os números, vigia
 * o estado dos registros e entrega cada evento ao controlador — EM ORDEM.
 *
 * Ordem importa: o `ChannelDestroyed` de um ramal que recusou precisa ser
 * tratado depois do `StasisStart` que o criou, ou o controlador toca o próximo
 * enquanto ainda acha que o anterior está tocando. Uma fila serial basta: o
 * volume de eventos de telefonia é de dezenas por ligação, não de milhares.
 *
 * Ao lado da fila, a PASSADA de 60 s que não depende da ARI (`passadaDoTelefone`):
 * os avisos de instabilidade vencidos, as falas do Storage para o volume
 * `telefonia-falas` e a limpeza do Storage (desenho da fase 2, §4 e §5.5).
 *
 * Sem `TELEFONIA_ARI_URL`/`TELEFONIA_ARI_PASSWORD` o laço não sobe — a
 * telefonia é um profile opcional do compose (spec 20 §4.3). Nem a passada: o
 * volume segue montado no worker (docker-compose.prod.yml), vazio, e nada é
 * escrito nele.
 */
import type pg from "pg";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { ClienteAri, ErroAri, configAriDoAmbiente, type CanalAri } from "./ari";
import { ControladorDeChamadas, type EventoAri, type PortaAri, type PortaBanco, type Registro } from "./controle";
import { DIRETORIO_DAS_FALAS, FalasNoDisco, falasNoDiscoDaInstalacao, type ArmazemDasFalas } from "./falas-no-disco";
import { idDoRamal } from "./pjsip";
import * as repo from "./repositorio";
import { SincronizadorDeTroncos } from "./sincronizacao";

const RECONCILIAR_MS = 60_000;
const LER_ESTADOS_MS = 15_000;
const BACKOFF_MAX_MS = 30_000;

function portaAri(ari: ClienteAri): PortaAri {
  return {
    atender: (c) => ari.atender(c),
    indicarChamando: (c) => ari.indicarChamando(c),
    desligar: (c, m) => ari.desligar(c, m),
    originar: (p) => ari.originar(p),
    criarCanal: (p) => ari.criarCanal(p),
    discar: (c, s) => ari.discar(c, s),
    criarPonte: (id) => ari.criarPonte(id),
    porNaPonte: (p, c) => ari.porNaPonte(p, c),
    destruirPonte: (p) => ari.destruirPonte(p),
    musicaDeEspera: (c) => ari.musicaDeEspera(c),
    pararMusica: (c) => ari.pararMusica(c),
    tocarTom: (c, t) => ari.tocarTom(c, t),
    pararReproducao: (id) => ari.pararReproducao(id),
    tocarFala: async (c, m) => (await ari.tocarFala(c, m)).id,
    pararFala: (id) => ari.pararFala(id),
    ramalOnline: async (userId) => {
      try {
        const ep = await ari.pedir<{ state: string }>("GET", `/endpoints/PJSIP/${idDoRamal(userId)}`);
        return ep.state === "online";
      } catch (e) {
        if (e instanceof ErroAri && e.status === 404) return false;
        throw e;
      }
    },
    pontes: () => ari.pedir<Array<{ id: string; channels: string[] }>>("GET", "/bridges"),
    canais: () => ari.listarCanais(),
  };
}

function portaBanco(pool: pg.Pool): PortaBanco {
  return {
    troncoPorId: (id) => repo.troncoPorId(pool, id),
    disponiveisNoTime: (org, team, agora) => repo.disponiveisNoTime(pool, org, team, agora),
    timeParaAFila: (org, team, agora) => repo.timeParaAFila(pool, org, team, agora),
    falasGerais: (org) => repo.falasGerais(pool, org),
    menuPorId: (org, id) => repo.menuPorId(pool, org, id),
    registrarEscolhaDoMenu: (org, id, e) => repo.registrarEscolhaDoMenu(pool, org, id, e),
    avisarMenuComTimeArquivado: (org, menu) => repo.avisarMenuComTimeArquivado(pool, org, menu),
    registrarAvisoOuvido: (org, id) => repo.registrarAvisoOuvido(pool, org, id),
    avisarFalaIntocavel: (org, rotulo) => repo.avisarFalaIntocavel(pool, org, rotulo),
    acharOuCriarContato: (org, e164, nome) => repo.acharOuCriarContato(pool, org, e164, nome),
    acharOuCriarConversa: (org, c, t, team) => repo.acharOuCriarConversa(pool, org, c, t, team),
    criarLigacao: (l) => repo.criarLigacao(pool, l),
    ligacaoDoAtendente: (u, id) => repo.ligacaoDoAtendente(pool, u, id),
    ligacoesVivas: () => repo.ligacoesVivas(pool),
    marcarTocando: (org, id, u) => repo.marcarTocando(pool, org, id, u),
    marcarAtendida: (org, id, u) => repo.marcarAtendida(pool, org, id, u),
    encerrarLigacao: (org, id, m) => repo.encerrarLigacao(pool, org, id, m),
    atribuirConversa: (org, c, u) => repo.atribuirConversa(pool, org, c, u),
    registrarNaConversa: (l, d, ms) => repo.registrarNaConversa(pool, l, d, ms),
    avisarPerdida: (l) => repo.avisarPerdida(pool, l),
    registrarFim: (l, d, m) => repo.registrarFim(pool, l, d, m),
  };
}

/**
 * O armazém de reserva: a instalação sem cliente do Storage (credencial de
 * serviço ausente ou inválida). Ler FALHA — e não devolve `null`, que no armazém
 * quer dizer "o objeto não existe" (lib/telefonia/armazem.ts): aqui ninguém
 * perguntou ao Storage. Assim `FalasNoDisco` registra UMA queda do Storage, na
 * transição, em vez de uma "fala pronta sem áudio" por fala. `apagar` não remove
 * nada (`[]`) — e nem é alcançado, porque sem pastas listadas a limpeza para antes.
 */
export const ARMAZEM_SEM_STORAGE: ArmazemDasFalas = Object.freeze({
  baixar: async () => {
    throw new Error("sem cliente do Storage nesta instalação");
  },
  listarPastas: async () => {
    throw new Error("sem cliente do Storage nesta instalação");
  },
  listarObjetos: async () => {
    throw new Error("sem cliente do Storage nesta instalação");
  },
  apagar: async () => [],
});

/**
 * O disco das falas do worker: o volume da instalação, com o Storage pelo cliente
 * de serviço (`falasNoDiscoDaInstalacao`). Sem esse cliente, o mesmo volume com o
 * armazém de reserva: o laço sobe assim mesmo — as ligações seguem, pulando as
 * falas — e o log diz por quê uma vez. Nunca a ElevenLabs: o worker não a
 * alcança (tests/unit/ligacao-nunca-chama-elevenlabs.test.ts).
 */
export function falasDoWorker(db: Queryable, log: Registro): FalasNoDisco {
  try {
    return falasNoDiscoDaInstalacao(db, log);
  } catch (e) {
    log.error("telefonia: sem cliente do Storage — as falas do telefone não chegam ao disco", {
      erro: String(e).slice(0, 200),
    });
    return new FalasNoDisco(DIRETORIO_DAS_FALAS, db, ARMAZEM_SEM_STORAGE, log);
  }
}

export interface DependenciasDaPassada {
  falas: Pick<FalasNoDisco, "sincronizar" | "limparStorage">;
  /** `repo.desligarAvisosVencidos` com o pool do worker: desliga, audita e avisa na Central. */
  desligarAvisosVencidos: (agora: Date) => Promise<repo.AvisoDesligado[]>;
  log: Registro;
  /** Relógio. Padrão: `new Date()`. */
  agora?: () => Date;
}

/**
 * A passada de 60 s do telefone que NÃO depende da ARI — roda com o Asterisk fora:
 *  1. os avisos de instabilidade VENCIDOS (§5.5): desligados, auditados
 *     (`phone.emergency_expired`) e avisados na Central por
 *     `desligarAvisosVencidos` num comando só; aqui só entram no log. Primeiro,
 *     porque é um comando só e não deve esperar a sincronização, que pode passar
 *     minutos baixando arquivo;
 *  2. as falas do Storage para o volume (`sincronizar`);
 *  3. a limpeza do Storage (`limparStorage`, com freio próprio de 10 min —
 *     `INTERVALO_DA_LIMPEZA_MS` —, então pode ser chamada a cada passada).
 *
 * Cada etapa é isolada: a que falha não impede as outras nem a próxima passada.
 * Sem inundar o log (30 MB, divididos com o motor da IA): `FalasNoDisco` registra
 * as próprias quedas na transição, e a etapa que LANÇA — `desligarAvisosVencidos`
 * com o banco fora; `sincronizar`/`limparStorage` só se quebrarem o contrato de
 * nunca lançar — é registrada uma vez ao cair e uma ao voltar. Passada sem efeito
 * não escreve nada. Sem reentrância: a passada lenta não empilha outra.
 */
export function passadaDoTelefone(d: DependenciasDaPassada): () => Promise<void> {
  const agora = d.agora ?? (() => new Date());
  const fora = new Set<string>();
  let emCurso = false;

  const etapa = async (nome: string, rodar: () => Promise<void>) => {
    try {
      await rodar();
    } catch (e) {
      if (!fora.has(nome)) {
        fora.add(nome);
        d.log.warn(`telefonia: a passada de ${nome} falhou — tenta de novo a cada minuto`, { erro: String(e).slice(0, 200) });
      }
      return;
    }
    if (fora.delete(nome)) d.log.info(`telefonia: a passada de ${nome} voltou a funcionar`);
  };

  return async () => {
    if (emCurso) return;
    emCurso = true;
    try {
      await etapa("avisos de instabilidade vencidos", async () => {
        for (const v of await d.desligarAvisosVencidos(agora())) {
          d.log.info("telefonia: aviso de instabilidade venceu e foi desligado", {
            team_id: v.id,
            organization_id: v.organizationId,
          });
        }
      });
      await etapa("falas no disco", async () => {
        await d.falas.sincronizar();
      });
      await etapa("limpeza do Storage das falas", async () => {
        await d.falas.limparStorage();
      });
    } finally {
      emCurso = false;
    }
  };
}

export interface EstadoDaTelefonia {
  conectada: boolean;
  ligacoesAtivas: number;
}

/**
 * Roda até o `signal` abortar. Nunca lança: queda da ARI vira reconexão com
 * backoff, e um evento que falha é registrado e não derruba o laço.
 */
export async function runTelefoniaLoop(opts: {
  pool: pg.Pool;
  signal: AbortSignal;
  log: Registro;
  estado?: EstadoDaTelefonia;
}): Promise<void> {
  const cfg = configAriDoAmbiente();
  if (!cfg) {
    opts.log.info("telefonia: desligada nesta instalação (TELEFONIA_ARI_URL/TELEFONIA_ARI_PASSWORD ausentes)");
    return;
  }
  const ari = new ClienteAri(cfg);
  const falas = falasDoWorker(opts.pool, opts.log);
  const ctl = new ControladorDeChamadas(portaAri(ari), portaBanco(opts.pool), opts.log, Date.now, falas);
  const sync = new SincronizadorDeTroncos(ari, opts.pool, opts.log, {
    host: new URL(cfg.baseUrl).hostname,
    senha: cfg.senha,
  });
  const estado = opts.estado ?? { conectada: false, ligacoesAtivas: 0 };

  let fila: Promise<void> = Promise.resolve();
  const enfileirar = (fn: () => Promise<void>) => {
    fila = fila.then(fn).catch((e) => opts.log.error("telefonia: tarefa falhou", { erro: String(e).slice(0, 300) }));
    return fila;
  };
  ctl.usarFila(enfileirar);

  // Fora da fila serial: baixar arquivo não pode atrasar o evento de uma ligação.
  const passada = passadaDoTelefone({
    falas,
    desligarAvisosVencidos: (agora) => repo.desligarAvisosVencidos(opts.pool, agora),
    log: opts.log,
  });
  void passada();

  const reconciliar = setInterval(() => {
    if (estado.conectada) void enfileirar(() => sync.sincronizar(false));
    void passada();
  }, RECONCILIAR_MS);
  const lerEstados = setInterval(() => {
    if (estado.conectada) void sync.atualizarEstados().catch(() => undefined);
    estado.ligacoesAtivas = ctl.ativas;
  }, LER_ESTADOS_MS);

  let espera = 1_000;
  try {
    while (!opts.signal.aborted) {
      const fechou = await new Promise<string>((resolve) => {
        let ws: WebSocket;
        try {
          ws = ari.abrirEventos();
        } catch (e) {
          resolve(`abrir: ${String(e)}`);
          return;
        }
        const aoAbortar = () => ws.close();
        opts.signal.addEventListener("abort", aoAbortar, { once: true });
        ws.onopen = () => {
          espera = 1_000;
          estado.conectada = true;
          opts.log.info("telefonia: conectada ao Asterisk");
          void enfileirar(async () => {
            await sync.sincronizar(true);
            await ctl.recuperar();
          });
        };
        ws.onmessage = (m) => {
          let ev: EventoAri;
          try {
            ev = JSON.parse(String(m.data)) as EventoAri;
          } catch {
            return;
          }
          void enfileirar(() => ctl.tratar(ev));
        };
        ws.onerror = () => undefined;
        ws.onclose = (c) => {
          opts.signal.removeEventListener("abort", aoAbortar);
          estado.conectada = false;
          resolve(`fechou (${c.code})`);
        };
      });
      if (opts.signal.aborted) break;
      opts.log.warn("telefonia: conexão com o Asterisk caiu — reconectando", { motivo: fechou, em_ms: espera });
      await new Promise((r) => setTimeout(r, espera));
      espera = Math.min(espera * 2, BACKOFF_MAX_MS);
    }
  } finally {
    clearInterval(reconciliar);
    clearInterval(lerEstados);
  }
}

export type { CanalAri };
