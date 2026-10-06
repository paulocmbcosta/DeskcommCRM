/**
 * O laço da telefonia no worker: conecta na ARI, sincroniza os números, vigia
 * o estado dos registros e entrega cada evento ao controlador — EM ORDEM.
 *
 * Ordem importa: o `ChannelDestroyed` de um ramal que recusou precisa ser
 * tratado depois do `StasisStart` que o criou, ou o controlador toca o próximo
 * enquanto ainda acha que o anterior está tocando. Uma fila serial basta: o
 * volume de eventos de telefonia é de dezenas por ligação, não de milhares.
 *
 * Ao lado da fila, a PASSADA de 60 s (`passadaDoTelefone`): os avisos de
 * instabilidade vencidos, as falas do Storage para o volume `telefonia-falas`, a
 * limpeza do Storage (desenho da fase 2, §4 e §5.5) e o cartão de ligação que
 * ficou "em andamento" depois de ela acabar (fila visível, entrega 1) — que não
 * dependem da ARI — e as GRAVAÇÕES das ligações que ficaram por guardar (F3,
 * `gravacoes.ts`), que dependem: com o Asterisk fora, só essa etapa falha, e
 * tenta no minuto seguinte.
 *
 * Sem `TELEFONIA_ARI_URL`/`TELEFONIA_ARI_PASSWORD` o laço não sobe — a
 * telefonia é um profile opcional do compose (spec 20 §4.3). Nem a passada: o
 * volume segue montado no worker (docker-compose.prod.yml), vazio, e nada é
 * escrito nele.
 */
import type pg from "pg";

import { ClienteAri, ErroAri, configAriDoAmbiente, type CanalAri } from "./ari";
import { ControladorDeChamadas, type EventoAri, type PortaAri, type PortaBanco, type Registro } from "./controle";
import { falasDoWorker, type FalasNoDisco } from "./falas-no-disco";
import { gravacoesDoWorker, type GravacoesDaTelefonia } from "./gravacoes";
import { idDoRamal } from "./pjsip";
import * as repo from "./repositorio";
import { SincronizadorDeTroncos } from "./sincronizacao";

const RECONCILIAR_MS = 60_000;
const LER_ESTADOS_MS = 15_000;
const BACKOFF_MAX_MS = 30_000;
/**
 * Quanto uma abertura pode demorar. Na rede do Docker o aperto de mão leva
 * milissegundos; passou disso, o Asterisk está subindo ou travado, e a conexão
 * é largada para a tentativa seguinte. Sem este prazo, um Asterisk que aceita o
 * TCP e não responde seguraria CADA tentativa por 5 min (medido na imagem do
 * worker: o primeiro sinal do WebSocket é um `error` aos 302 s).
 */
const PRAZO_DE_ABERTURA_MS = 10_000;

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
    musicaNaPonte: (p) => ari.musicaNaPonte(p),
    pararMusicaNaPonte: (p) => ari.pararMusicaNaPonte(p),
    tirarDaPonte: (p, c) => ari.tirarDaPonte(p, c),
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
    marcarNaFila: (org, id) => repo.marcarNaFila(pool, org, id),
    marcarPrazoDaFila: (org, id, ms) => repo.marcarPrazoDaFila(pool, org, id, ms),
    marcarAtendida: (org, id, u) => repo.marcarAtendida(pool, org, id, u),
    encerrarLigacao: (org, id, m, toque) => repo.encerrarLigacao(pool, org, id, m, toque),
    atribuirConversa: (org, c, u, m) => repo.atribuirConversa(pool, org, c, u, m),
    abrirCartaoDaLigacao: (org, id) => repo.abrirCartaoDaLigacao(pool, org, id),
    registrarNaConversa: (l, d, ms) => repo.registrarNaConversa(pool, l, d, ms),
    avisarPerdida: (l) => repo.avisarPerdida(pool, l),
    registrarFim: (l, d, m) => repo.registrarFim(pool, l, d, m),
    transferenciaAberta: (org, vc, id) => repo.transferenciaAberta(pool, org, vc, id),
    encerrarTransferencia: (org, id, fim) => repo.encerrarTransferencia(pool, org, id, fim),
    recusarTransferenciaOrfa: (id, vc, m) => repo.recusarTransferenciaOrfa(pool, id, vc, m),
    cancelarTransferenciasAbertas: (m) => repo.cancelarTransferenciasAbertas(pool, m),
    marcarTocandoNaTransferencia: (org, id, u) => repo.marcarTocandoNaTransferencia(pool, org, id, u),
    passarLigacao: (org, id, u) => repo.passarLigacao(pool, org, id, u),
    moverParaOTime: (org, id, c, t) => repo.moverParaOTime(pool, org, id, c, t),
    timeDaLigacao: (org, id) => repo.timeDaLigacao(pool, org, id),
    pessoaEmLigacao: (org, u) => repo.pessoaEmLigacao(pool, org, u),
    donoDoRamal: (org, n) => repo.donoDoRamal(pool, org, n),
    quemLiga: (org, u) => repo.quemLiga(pool, org, u),
    colegaLivreParaInterna: (org, u, vc) => repo.colegaLivreParaInterna(pool, org, u, vc),
  };
}

export interface DependenciasDaPassada {
  falas: Pick<FalasNoDisco, "sincronizar" | "limparStorage">;
  /**
   * As gravações das ligações (F3): guardar as pendentes e apagar as órfãs do
   * Asterisk. Ausente = a instalação não tem como guardar (sem Storage): nada a fazer.
   */
  gravacoes?: Pick<GravacoesDaTelefonia, "passada"> | null;
  /** `repo.desligarAvisosVencidos` com o pool do worker: desliga, audita e avisa na Central. */
  desligarAvisosVencidos: (agora: Date) => Promise<repo.AvisoDesligado[]>;
  /**
   * `repo.consertarCartoesOrfaos` com o pool do worker: fecha o cartão "em
   * andamento" de ligação já encerrada (fila visível, entrega 1). Ausente = nada a fazer.
   */
  consertarCartoes?: () => Promise<number>;
  log: Registro;
  /** Relógio. Padrão: `new Date()`. */
  agora?: () => Date;
  /** O desligamento do worker: dado o sinal, nenhuma passada nem etapa começa. */
  signal?: AbortSignal;
}

/** Roda `fn` sem reentrar: quem chega com uma execução em curso volta na hora, sem esperá-la. */
function semReentrancia(fn: () => Promise<void>): () => Promise<void> {
  let emCurso = false;
  return async () => {
    if (emCurso) return;
    emCurso = true;
    try {
      await fn();
    } finally {
      emCurso = false;
    }
  };
}

/**
 * A passada de 60 s do telefone que NÃO depende da ARI — roda com o Asterisk fora.
 * Três frentes, cada uma com a SUA guarda de reentrância:
 *  - os avisos de instabilidade VENCIDOS (§5.5): desligados, auditados
 *    (`phone.emergency_expired`) e avisados na Central por
 *    `desligarAvisosVencidos` num comando só; aqui só entram no log. Guarda
 *    própria porque a limpeza do Storage não tem prazo: com o Storage lento, uma
 *    guarda comum pularia passadas inteiras e o aviso vencido — e com ele a
 *    auditoria e a Central — esperaria o Storage;
 *  - o Storage: as falas para o volume (`sincronizar`) e, depois, a limpeza do
 *    bucket (`limparStorage`, com freio próprio de 10 min —
 *    `INTERVALO_DA_LIMPEZA_MS` —, então pode ser chamada a cada passada);
 *  - o cartão "Ligação em andamento" de ligação que JÁ ACABOU (fila visível,
 *    entrega 1): o fim fechou a ligação no banco e não conseguiu completar o
 *    cartão; `consertarCartoes` o fecha pelo caminho de sempre, e só entra no log
 *    quando fechou algum. Guarda própria pelo motivo dos avisos: só fala com o
 *    banco, e não pode esperar o Storage.
 *
 * Cada etapa é isolada: a que falha não impede as outras nem a próxima passada.
 * Sem inundar o log (30 MB, divididos com o motor da IA): `FalasNoDisco` registra
 * as próprias quedas na transição, e a etapa que LANÇA — `desligarAvisosVencidos`
 * e `consertarCartoes` com o banco fora; `sincronizar`/`limparStorage` só se
 * quebrarem o contrato de nunca lançar — é registrada uma vez ao cair e uma ao
 * voltar. Passada sem efeito não escreve nada.
 *
 * No desligamento (`signal`), nenhuma passada nem etapa começa, e a etapa que
 * falha DEPOIS do sinal não é registrada: o worker encerra o pool em seguida
 * (workers/agent-worker/main.ts), e a falha é do desligamento, não do banco.
 */
export function passadaDoTelefone(d: DependenciasDaPassada): () => Promise<void> {
  const agora = d.agora ?? (() => new Date());
  const desligando = () => d.signal?.aborted === true;
  const fora = new Set<string>();

  const etapa = async (nome: string, rodar: () => Promise<void>) => {
    if (desligando()) return;
    try {
      await rodar();
    } catch (e) {
      if (desligando()) return;
      if (!fora.has(nome)) {
        fora.add(nome);
        d.log.warn(`telefonia: a passada de ${nome} falhou — tenta de novo a cada minuto`, { erro: String(e).slice(0, 200) });
      }
      return;
    }
    if (fora.delete(nome)) d.log.info(`telefonia: a passada de ${nome} voltou a funcionar`);
  };

  const avisos = semReentrancia(() =>
    etapa("avisos de instabilidade vencidos", async () => {
      for (const v of await d.desligarAvisosVencidos(agora())) {
        d.log.info("telefonia: aviso de instabilidade venceu e foi desligado", {
          team_id: v.id,
          organization_id: v.organizationId,
        });
      }
    }),
  );
  const storage = semReentrancia(async () => {
    await etapa("falas no disco", async () => {
      await d.falas.sincronizar();
    });
    await etapa("limpeza do Storage das falas", async () => {
      await d.falas.limparStorage();
    });
  });
  // Guarda própria: uma conversão longa (ligação de 2 h) não pode atrasar as
  // falas nem os avisos vencidos — e vice-versa.
  const gravacoes = semReentrancia(async () => {
    const g = d.gravacoes;
    if (!g) return;
    await etapa("gravações das ligações", async () => {
      await g.passada();
    });
  });
  // O cartão "em andamento" de ligação que já acabou: o fim fechou a ligação no
  // banco e não conseguiu completar o cartão. Sem isto ele diria "em andamento" para sempre.
  const cartoes = semReentrancia(() =>
    etapa("cartões de ligação em andamento", async () => {
      const consertar = d.consertarCartoes;
      if (!consertar) return;
      const n = await consertar();
      if (n > 0) d.log.info("telefonia: cartão de ligação em andamento fechado pela passada", { cartoes: n });
    }),
  );

  return async () => {
    if (desligando()) return;
    await Promise.all([avisos(), storage(), gravacoes(), cartoes()]);
  };
}

/**
 * O registro das falas no disco, que se cala no desligamento: dado o sinal, o
 * worker encerra o pool (workers/agent-worker/main.ts) enquanto um download ou
 * uma consulta da passada ainda pode estar em curso — e `FalasNoDisco` leria a
 * falha como "o banco caiu". Aviso e erro depois do sinal não entram no log; a
 * informação segue.
 */
function registroQueCalaAoDesligar(log: Registro, signal: AbortSignal): Registro {
  return {
    info: (...a) => log.info(...a),
    warn: (...a) => {
      if (!signal.aborted) log.warn(...a);
    },
    error: (...a) => {
      if (!signal.aborted) log.error(...a);
    },
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
  const falas = falasDoWorker(opts.pool, registroQueCalaAoDesligar(opts.log, opts.signal));
  // Sem cliente do Storage não há onde guardar: melhor não gravar do que gravar
  // arquivos que ninguém vai ouvir (e que o Asterisk acumularia).
  let gravacoes: GravacoesDaTelefonia | null = null;
  try {
    gravacoes = gravacoesDoWorker(opts.pool, ari, opts.log);
  } catch (e) {
    opts.log.error("telefonia: sem cliente do Storage — as ligações não serão gravadas", { erro: String(e).slice(0, 200) });
  }
  const ctl = new ControladorDeChamadas(
    portaAri(ari),
    portaBanco(opts.pool),
    opts.log,
    Date.now,
    falas,
    gravacoes ?? undefined,
  );
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

  // Fora da fila serial: baixar arquivo não pode atrasar o evento de uma ligação
  // nem a reconciliação dos troncos.
  const passada = passadaDoTelefone({
    falas,
    gravacoes,
    desligarAvisosVencidos: (agora) => repo.desligarAvisosVencidos(opts.pool, agora),
    consertarCartoes: () => repo.consertarCartoesOrfaos(opts.pool),
    log: opts.log,
    signal: opts.signal,
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
        // A ÚNICA saída desta conexão. Esperar o `close` prendia o laço para
        // sempre — e o desligamento do worker junto: o WebSocket do Node 22
        // (undici 6) não o dispara quando a ABERTURA falha (vem só `error`), e não
        // dispara nada se o Asterisk aceita o TCP e não responde.
        //
        // O socket é largado ANTES de o laço seguir: sem tratadores, um `open` ou
        // evento tardio não chega a ninguém; e `close()` cancela a abertura em
        // curso — a tentativa seguinte nunca convive com esta. Na ARI só um
        // WebSocket assina o app, e o mais novo toma o lugar do anterior: uma
        // abertura largada que vingasse depois calaria a conexão que vale.
        let aberta = false;
        const encerrar = (motivo: string) => {
          clearTimeout(prazo);
          opts.signal.removeEventListener("abort", aoAbortar);
          // Os tratadores saem ANTES do `close()`, e a ordem não é estética: num
          // socket que não abriu, `close()` dispara `error` DENTRO da chamada — com
          // o tratador ainda posto, ele voltaria aqui sem fim (medido no Node 22:
          // `RangeError` de pilha, que derruba o worker inteiro).
          ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
          estado.conectada = false;
          ws.close();
          resolve(motivo);
        };
        const aoAbortar = () => encerrar("desligando");
        const prazo = setTimeout(
          () => encerrar(`não abriu em ${PRAZO_DE_ABERTURA_MS / 1_000} s`),
          PRAZO_DE_ABERTURA_MS,
        );
        opts.signal.addEventListener("abort", aoAbortar, { once: true });
        ws.onopen = () => {
          aberta = true;
          clearTimeout(prazo);
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
        ws.onerror = () => encerrar(aberta ? "erro na conexão" : "a abertura falhou");
        ws.onclose = (c) => encerrar(`fechou (${c.code})`);
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
