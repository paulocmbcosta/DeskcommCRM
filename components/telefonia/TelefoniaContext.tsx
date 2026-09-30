"use client";
/**
 * O TELEFONE NO NAVEGADOR — o ramal do atendente (spec 20 §4.1 e §7).
 *
 * Pede a credencial do ramal (`POST /api/v1/telefonia/ramal`), registra no
 * Asterisk por WebSocket (JsSIP) e expõe o que a tela precisa: ligar, atender,
 * recusar, desligar, mudo e teclado. Organização sem número conectado, ou
 * instalação sem telefonia: não registra nada, e `pronto` fica `false` — os
 * botões de ligar simplesmente não aparecem.
 *
 * Quem decide para quem a ligação toca é o servidor. Este contexto só sabe da
 * ligação que chegou a ESTE ramal. O estado de verdade (chamando, atendeu,
 * encerrou) vem do banco por `GET /api/v1/telefonia/chamadas/[id]`: o ramal é
 * atendido pelo Asterisk na hora, para o atendente ouvir o chamar da operadora,
 * e o JsSIP sozinho não distingue "chamando" de "atendeu".
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { UA as JsSipUA } from "jssip";
import type { RTCSession } from "jssip/lib/RTCSession";

import { apiClient } from "@/lib/api/client";
import { avisoDoFimDaSaida } from "@/lib/telefonia/fim-da-saida";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { usePermission } from "@/hooks/auth/AuthProvider";

type UA = JsSipUA;
type Sessao = RTCSession;

export interface NumeroDaEmpresa {
  id: string;
  nome: string | null;
  numero: string | null;
  conectado: boolean;
}

interface Ramal {
  ativo: boolean;
  usuario?: string;
  senha?: string;
  ws_url?: string;
  numeros?: NumeroDaEmpresa[];
}

export interface EstadoDaLigacao {
  id: string | null;
  direcao: "entrada" | "saida";
  /** discando = pedido criado, INVITE saindo; tocando = recebida esperando atender. */
  fase: "discando" | "chamando" | "tocando" | "em_ligacao";
  numero: string;
  nome: string | null;
  contatoId: string | null;
  conversaId: string | null;
  atendidaEm: number | null;
  mudo: boolean;
  /**
   * Por que o ramal tocou (header `X-Transferencia`, v2): `transf`/`fila` = é
   * uma transferência chegando; `volta` = a que eu transferi voltou; `consulta`
   * = um colega quer falar antes; `null` = uma ligação comum.
   */
  papelDaEntrada: string | null;
  /** A transferência ABERTA desta ligação (v2), como o banco a vê. */
  transferencia: TransferenciaAberta | null;
  /** Quem me transferiu esta ligação (a transferência que pegou em mim). */
  transferidaPor: string | null;
  /** A última transferência que fechou envolvendo a mim (o painel diz o que houve). */
  ultimaTransferencia: UltimaTransferencia | null;
  /** Ligação interna (v3): entre ramais, sem cliente — não pode ser transferida (D16). */
  interna: boolean;
}

export interface TransferenciaAberta {
  id: string;
  tipo: "blind" | "attended";
  de_user_id: string | null;
  de_nome: string | null;
  para_nome: string | null;
  para_time: string | null;
  /** Consultada: o colega ainda tocando, ou já na linha comigo. */
  consulta: "tocando" | "falando" | null;
}

export interface UltimaTransferencia {
  id: string;
  tipo: "blind" | "attended";
  desfecho: string | null;
  motivo: string | null;
  de_nome: string | null;
  para_nome: string | null;
  para_time: string | null;
  fui_eu: boolean;
  fechada_em: string | null;
}

export type DestinoDaTransferencia = { user_id: string } | { team_id: string };

export interface Encerramento {
  motivo: string;
  em: number;
  /** A ligação de SAÍDA que acabou (para ler o desfecho do banco); `null` na recebida. */
  saidaId: string | null;
  /**
   * O que o atendente precisa ler sobre a saída que não completou — texto em
   * português, chave do dicionário. Chega DEPOIS do fim: o worker derruba o
   * ramal antes de gravar o motivo, então o navegador lê o banco em seguida.
   */
  aviso: string | null;
}

interface ContextoDoTelefone {
  /** Ramal registrado: dá para ligar e receber. */
  pronto: boolean;
  /** A organização tem telefone (mesmo que o ramal ainda esteja conectando). */
  disponivel: boolean;
  numeros: NumeroDaEmpresa[];
  ligacao: EstadoDaLigacao | null;
  ultimoEncerramento: Encerramento | null;
  ligar(p: { contatoId?: string; numero?: string; numeroDaEmpresaId?: string; nome?: string | null }): Promise<void>;
  atender(): void;
  desligar(): void;
  alternarMudo(): void;
  teclar(digito: string): void;
  /** Transfere a ligação em curso (v2). `false` = a API recusou (o motivo já apareceu). */
  transferir(p: { modo: "direta" | "consultada"; para: DestinoDaTransferencia }): Promise<boolean>;
  /** Na consulta: passa o cliente ao colega (`completar`) ou volta ao cliente (`voltar`). */
  decidirConsulta(acao: "completar" | "voltar"): Promise<void>;
}

const Contexto = createContext<ContextoDoTelefone | null>(null);

export function useTelefonia(): ContextoDoTelefone {
  const c = useContext(Contexto);
  if (!c) {
    return {
      pronto: false,
      disponivel: false,
      numeros: [],
      ligacao: null,
      ultimoEncerramento: null,
      ligar: async () => undefined,
      atender: () => undefined,
      desligar: () => undefined,
      alternarMudo: () => undefined,
      teclar: () => undefined,
      transferir: async () => false,
      decidirConsulta: async () => undefined,
    };
  }
  return c;
}

interface DetalheDaLigacao {
  id: string;
  status: string;
  direction: string;
  peer_phone: string;
  answered_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  conversation_id: string | null;
  contact_id: string | null;
  contact_name: string | null;
  // v2 (transferência) e v3 (interna)
  peer_user_name?: string | null;
  transferencia?: TransferenciaAberta | null;
  transferida_por?: { de_nome: string | null } | null;
  ultima_transferencia?: UltimaTransferencia | null;
}

const RETENTAR_REGISTRO_MS = 15_000;

export function TelefoniaProvider({ children }: { children: ReactNode }) {
  // `voice.call` (agent+) é a ação de "ligar e atender" — o mesmo piso da rota
  // `POST /api/v1/telefonia/ramal` (`requireRole("agent")`), e o acompanhamento
  // somente-leitura, rebaixado a viewer, fica de fora como lá. Era
  // `usePermission("agent")`: nome de PAPEL onde se espera AÇÃO, `false` para
  // todo mundo menos o administrador da plataforma — em produção, só o dono
  // recebia ramal. O tipo de `usePermission` agora recusa isso na compilação.
  const podeAtender = usePermission("voice.call");
  const [ramal, setRamal] = useState<Ramal | null>(null);
  const [pronto, setPronto] = useState(false);
  const [ligacao, setLigacao] = useState<EstadoDaLigacao | null>(null);
  const [ultimoEncerramento, setUltimoEncerramento] = useState<Encerramento | null>(null);
  const uaRef = useRef<UA | null>(null);
  const sessaoRef = useRef<Sessao | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Id da ligação de saída em curso — para ler, no fim, por que ela acabou. */
  const saidaRef = useRef<string | null>(null);
  const [tentativa, setTentativa] = useState(0);

  // 1. A credencial do ramal. Pedida de novo quando o registro é recusado
  //    (o Asterisk reiniciou e esqueceu o ramal) — `tentativa` muda.
  useEffect(() => {
    if (!podeAtender) return;
    let vivo = true;
    apiClient
      .post<{ data: Ramal }>("/api/v1/telefonia/ramal", {})
      .then((r) => vivo && setRamal(r.data))
      .catch(() => vivo && setRamal({ ativo: false }));
    return () => {
      vivo = false;
    };
  }, [podeAtender, tentativa]);

  // Sem ramal ativo (a organização ainda não tinha número quando a página
  // abriu), pergunta de novo — a cada minuto e quando a aba volta ao foco. Sem
  // isto, quem acabou de conectar o primeiro número ficava sem telefone até
  // recarregar a página (medido na prova pela tela).
  const ativo = Boolean(ramal?.ativo);
  useEffect(() => {
    if (!podeAtender || ativo || ramal === null) return;
    const perguntar = () => setTentativa((n) => n + 1);
    const t = setInterval(perguntar, 60_000);
    const aoFocar = () => document.visibilityState === "visible" && perguntar();
    document.addEventListener("visibilitychange", aoFocar);
    window.addEventListener("telefonia:numeros-mudaram", perguntar);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", aoFocar);
      window.removeEventListener("telefonia:numeros-mudaram", perguntar);
    };
  }, [podeAtender, ativo, ramal]);

  const limparSessao = useCallback((motivo: string) => {
    sessaoRef.current = null;
    setLigacao(null);
    const saidaId = saidaRef.current;
    saidaRef.current = null;
    setUltimoEncerramento({ motivo, em: Date.now(), saidaId, aviso: null });
    if (audioRef.current) audioRef.current.srcObject = null;
  }, []);

  // A saída que acabou sem ninguém atender: POR QUE acabou está no banco, não
  // no SIP — o Asterisk atende o ramal na hora e o derruba com um BYE comum,
  // seja a operadora recusando (404 em 0,2 s), seja o número ocupado. O worker
  // grava o motivo logo DEPOIS de derrubar o ramal, então a leitura insiste por
  // alguns segundos até a ligação constar como encerrada.
  const saidaEncerrada = ultimoEncerramento?.saidaId ?? null;
  const encerradaEm = ultimoEncerramento?.em ?? null;
  useEffect(() => {
    if (!saidaEncerrada || encerradaEm === null) return;
    let vivo = true;
    let tentativas = 0;
    let relogio: ReturnType<typeof setTimeout> | null = null;
    const ler = async () => {
      tentativas += 1;
      try {
        const d = (await apiClient.get<{ data: DetalheDaLigacao }>(`/api/v1/telefonia/chamadas/${saidaEncerrada}`)).data;
        if (!vivo) return;
        if (d.status === "ended") {
          const aviso = avisoDoFimDaSaida(d);
          if (aviso) setUltimoEncerramento((u) => (u && u.em === encerradaEm ? { ...u, aviso } : u));
          return;
        }
      } catch {
        /* tenta de novo abaixo */
      }
      if (vivo && tentativas < 8) relogio = setTimeout(() => void ler(), 600);
    };
    void ler();
    return () => {
      vivo = false;
      if (relogio) clearTimeout(relogio);
    };
  }, [saidaEncerrada, encerradaEm]);

  const ligarAudio = useCallback((s: Sessao) => {
    const conectar = () => {
      const pc = s.connection;
      if (!pc) return;
      const tocar = (stream: MediaStream) => {
        if (audioRef.current) {
          audioRef.current.srcObject = stream;
          void audioRef.current.play().catch(() => undefined);
        }
      };
      pc.addEventListener("track", (e) => tocar(e.streams[0] ?? new MediaStream([e.track])));
      const receivers = pc.getReceivers?.() ?? [];
      if (receivers.length) tocar(new MediaStream(receivers.map((r) => r.track)));
    };
    if (s.connection) conectar();
    else s.on("peerconnection", conectar);
  }, []);

  // 2. O agente SIP. Recriado quando a credencial muda.
  useEffect(() => {
    if (!ramal?.ativo || !ramal.usuario || !ramal.senha || !ramal.ws_url) return;
    let encerrado = false;
    let ua: UA | null = null;
    let retentar: ReturnType<typeof setTimeout> | null = null;

    void import("jssip").then((JsSIP) => {
      if (encerrado) return;
      const socket = new JsSIP.WebSocketInterface(ramal.ws_url!);
      ua = new JsSIP.UA({
        sockets: [socket],
        uri: `sip:${ramal.usuario}@${window.location.hostname}`,
        authorization_user: ramal.usuario,
        password: ramal.senha,
        register: true,
        register_expires: 120,
        session_timers: false,
        user_agent: "SIP",
      });
      uaRef.current = ua;
      ua.on("registered", () => setPronto(true));
      ua.on("unregistered", () => setPronto(false));
      ua.on("registrationFailed", (e: { cause?: string }) => {
        setPronto(false);
        // Credencial recusada = o Asterisk esqueceu o ramal (reiniciou): pede outra.
        if (/authentication|rejected|forbidden/i.test(String(e.cause ?? ""))) {
          retentar = setTimeout(() => setTentativa((n) => n + 1), 1_000);
        } else {
          retentar = setTimeout(() => ua?.register(), RETENTAR_REGISTRO_MS);
        }
      });
      ua.on("newRTCSession", (ev: { session: Sessao; originator: string; request: { getHeader(n: string): string | undefined; from?: { display_name?: string; uri?: { user?: string } } } }) => {
        const s = ev.session;
        if (ev.originator === "remote") {
          // Já em ligação: recusa a segunda — o servidor passa para o próximo.
          if (sessaoRef.current) {
            s.terminate({ status_code: 486, reason_phrase: "Busy Here" });
            return;
          }
          sessaoRef.current = s;
          const id = ev.request.getHeader("X-Ligacao-Id") ?? null;
          setLigacao({
            id,
            direcao: "entrada",
            fase: "tocando",
            numero: ev.request.from?.uri?.user ?? "",
            nome: ev.request.from?.display_name ?? null,
            contatoId: null,
            conversaId: null,
            atendidaEm: null,
            mudo: false,
            papelDaEntrada: ev.request.getHeader("X-Transferencia") ?? null,
            transferencia: null,
            transferidaPor: null,
            ultimaTransferencia: null,
            interna: false,
          });
        }
        s.on("ended", () => limparSessao("encerrada"));
        s.on("failed", (e: { cause?: string }) => limparSessao(String(e.cause ?? "falhou")));
        s.on("confirmed", () =>
          setLigacao((l) => (l && l.direcao === "entrada" ? { ...l, fase: "em_ligacao", atendidaEm: Date.now() } : l)),
        );
        ligarAudio(s);
      });
      ua.start();
    });

    // Fechar a aba no meio da ligação: encerra de verdade (BYE), em vez de
    // deixar o cliente numa ponte com ninguém até o timeout de áudio.
    const aoSair = () => {
      try {
        sessaoRef.current?.terminate();
        ua?.stop();
      } catch {
        /* a página está indo embora */
      }
    };
    window.addEventListener("pagehide", aoSair);

    return () => {
      encerrado = true;
      window.removeEventListener("pagehide", aoSair);
      if (retentar) clearTimeout(retentar);
      setPronto(false);
      try {
        ua?.stop();
      } catch {
        /* já parado */
      }
      uaRef.current = null;
    };
  }, [ramal, ligarAudio, limparSessao]);

  // 3. O estado de verdade da ligação, do banco: nome do contato, conversa, e
  //    (na saída) quando o outro lado atendeu.
  const idDaLigacao = ligacao?.id ?? null;
  const fase = ligacao?.fase ?? null;
  useEffect(() => {
    if (!idDaLigacao) return;
    let vivo = true;
    const ler = async () => {
      try {
        const r = await apiClient.get<{ data: DetalheDaLigacao }>(`/api/v1/telefonia/chamadas/${idDaLigacao}`);
        if (!vivo) return;
        const d = r.data;
        setLigacao((l) => {
          if (!l || l.id !== d.id) return l;
          const atendeu = l.direcao === "saida" && d.status === "connected" && l.fase !== "em_ligacao";
          return {
            ...l,
            nome: d.contact_name ?? l.nome,
            numero: d.peer_phone || l.numero,
            contatoId: d.contact_id,
            conversaId: d.conversation_id,
            fase: atendeu ? "em_ligacao" : l.fase === "discando" && d.status === "ringing" ? "chamando" : l.fase,
            atendidaEm: atendeu ? Date.now() : l.atendidaEm,
            transferencia: d.transferencia ?? null,
            transferidaPor: d.transferida_por?.de_nome ?? null,
            ultimaTransferencia: d.ultima_transferencia ?? null,
            interna: d.direction === "internal",
          };
        });
      } catch {
        /* a próxima leitura tenta de novo */
      }
    };
    void ler();
    // O toque lê uma vez (o nome, a conversa, quem transferiu). Em ligação, a
    // leitura segue — mais espaçada — porque a transferência (v2) muda o que o
    // painel diz: "chamando Bruno…", "Bruno atendeu", a recusa e o motivo.
    if (fase === "tocando") return () => void (vivo = false);
    const t = setInterval(ler, fase === "em_ligacao" ? 2_000 : 1_500);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [idDaLigacao, fase]);

  const ligar = useCallback<ContextoDoTelefone["ligar"]>(
    async (p) => {
      const ua = uaRef.current;
      if (!ua || !pronto || sessaoRef.current) return;
      let pedido: { id: string; destino: string };
      try {
        pedido = (
          await apiClient.post<{ data: { id: string; destino: string } }>("/api/v1/telefonia/chamadas", {
            ...(p.contatoId ? { contact_id: p.contatoId } : { numero: p.numero }),
            ...(p.numeroDaEmpresaId ? { numero_da_empresa_id: p.numeroDaEmpresaId } : {}),
          })
        ).data;
      } catch (e) {
        showApiError(e);
        return;
      }
      saidaRef.current = pedido.id;
      // Uma ligação nova tira da tela o aviso da anterior.
      setUltimoEncerramento(null);
      setLigacao({
        id: pedido.id,
        direcao: "saida",
        fase: "discando",
        numero: p.numero ?? "",
        nome: p.nome ?? null,
        contatoId: p.contatoId ?? null,
        conversaId: null,
        atendidaEm: null,
        mudo: false,
        papelDaEntrada: null,
        transferencia: null,
        transferidaPor: null,
        ultimaTransferencia: null,
        interna: false,
      });
      const s = ua.call(`sip:${pedido.destino}@${window.location.hostname}`, {
        mediaConstraints: { audio: true, video: false },
        pcConfig: { iceServers: [] },
      }) as Sessao;
      sessaoRef.current = s;
    },
    [pronto],
  );

  const atender = useCallback(() => {
    const s = sessaoRef.current;
    if (!s) return;
    s.answer({ mediaConstraints: { audio: true, video: false }, pcConfig: { iceServers: [] } });
  }, []);

  const desligar = useCallback(() => {
    const s = sessaoRef.current;
    if (!s) return;
    try {
      s.terminate();
    } catch {
      limparSessao("encerrada");
    }
  }, [limparSessao]);

  const alternarMudo = useCallback(() => {
    const s = sessaoRef.current;
    if (!s) return;
    setLigacao((l) => {
      if (!l) return l;
      if (l.mudo) s.unmute({ audio: true });
      else s.mute({ audio: true });
      return { ...l, mudo: !l.mudo };
    });
  }, []);

  const teclar = useCallback((digito: string) => {
    sessaoRef.current?.sendDTMF(digito);
  }, []);

  // A transferência (v2): a API confere e manda a ordem ao serviço de telefonia;
  // o que acontece depois chega pela leitura da ligação (efeito 3).
  const idAtual = ligacao?.id ?? null;
  const transferir = useCallback<ContextoDoTelefone["transferir"]>(
    async (p) => {
      if (!idAtual) return false;
      try {
        await apiClient.post(`/api/v1/telefonia/chamadas/${idAtual}/transferir`, p);
        return true;
      } catch (e) {
        showApiError(e);
        return false;
      }
    },
    [idAtual],
  );

  const decidirConsulta = useCallback<ContextoDoTelefone["decidirConsulta"]>(
    async (acao) => {
      if (!idAtual) return;
      try {
        await apiClient.post(`/api/v1/telefonia/chamadas/${idAtual}/transferencia`, { acao });
      } catch (e) {
        showApiError(e);
      }
    },
    [idAtual],
  );

  const valor = useMemo<ContextoDoTelefone>(
    () => ({
      pronto,
      disponivel: Boolean(ramal?.ativo),
      numeros: ramal?.numeros ?? [],
      ligacao,
      ultimoEncerramento,
      ligar,
      atender,
      desligar,
      alternarMudo,
      teclar,
      transferir,
      decidirConsulta,
    }),
    [pronto, ramal, ligacao, ultimoEncerramento, ligar, atender, desligar, alternarMudo, teclar, transferir, decidirConsulta],
  );

  return (
    <Contexto.Provider value={valor}>
      {children}
      <audio ref={audioRef} autoPlay data-telefonia-audio className="hidden" />
    </Contexto.Provider>
  );
}
