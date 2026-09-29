/**
 * O laço da telefonia no worker: conecta na ARI, sincroniza os números, vigia
 * o estado dos registros e entrega cada evento ao controlador — EM ORDEM.
 *
 * Ordem importa: o `ChannelDestroyed` de um ramal que recusou precisa ser
 * tratado depois do `StasisStart` que o criou, ou o controlador toca o próximo
 * enquanto ainda acha que o anterior está tocando. Uma fila serial basta: o
 * volume de eventos de telefonia é de dezenas por ligação, não de milhares.
 *
 * Sem `TELEFONIA_ARI_URL`/`TELEFONIA_ARI_PASSWORD` o laço não sobe — a
 * telefonia é um profile opcional do compose (spec 20 §4.3).
 */
import type pg from "pg";

import { ClienteAri, ErroAri, configAriDoAmbiente, type CanalAri } from "./ari";
import { ControladorDeChamadas, type EventoAri, type PortaAri, type PortaBanco, type Registro } from "./controle";
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
  const ctl = new ControladorDeChamadas(portaAri(ari), portaBanco(opts.pool), opts.log);
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

  const reconciliar = setInterval(() => {
    if (estado.conectada) void enfileirar(() => sync.sincronizar(false));
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
