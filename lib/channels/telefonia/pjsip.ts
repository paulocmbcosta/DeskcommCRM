/**
 * Os objetos PJSIP que o CRM empurra para o Asterisk (spec 20 §4.1) — funções
 * puras: dado um tronco ou um ramal, a lista exata de campos. Quem manda é
 * `sincronizacao.ts`; aqui só se decide O QUE vai.
 *
 * Nomes previsíveis a partir do id do CRM, para o worker saber de quem é cada
 * canal sem tabela de correspondência: `tronco-<channel_session_id>` e
 * `ramal-<user_id>`.
 */
import type { CampoPjsip } from "./ari";
import { portaSipValida, prefixoDeDiscagemValido, servidorSipValido, usuarioSipValido } from "./conta-sip";

export type TransporteSip = "udp" | "tcp";

export interface TroncoSip {
  /** `channel_sessions.id` */
  id: string;
  servidor: string;
  porta: number;
  transporte: TransporteSip;
  usuario: string;
  senha: string;
}

export interface ObjetoPjsip {
  tipo: "auth" | "aor" | "endpoint" | "registration";
  id: string;
  campos: CampoPjsip[];
}

const PREFIXO_TRONCO = "tronco-";
const PREFIXO_RAMAL = "ramal-";

export const idDoTronco = (sessionId: string) => `${PREFIXO_TRONCO}${sessionId}`;
export const idDoRamal = (userId: string) => `${PREFIXO_RAMAL}${userId}`;

/** De volta: o endpoint de um canal do Asterisk → de quem ele é. */
export function donoDoEndpoint(endpoint: string): { tipo: "tronco" | "ramal"; id: string } | null {
  if (endpoint.startsWith(PREFIXO_TRONCO)) return { tipo: "tronco", id: endpoint.slice(PREFIXO_TRONCO.length) };
  if (endpoint.startsWith(PREFIXO_RAMAL)) return { tipo: "ramal", id: endpoint.slice(PREFIXO_RAMAL.length) };
  return null;
}

/**
 * O nome do canal do Asterisk (`PJSIP/tronco-<id>-0000002a`) → o endpoint.
 * O sufixo é o contador do canal, sempre 8 dígitos hex depois do último `-`.
 */
export function endpointDoCanal(nomeDoCanal: string): string | null {
  const m = /^PJSIP\/(.+)-[0-9a-f]{8}$/.exec(nomeDoCanal);
  return m ? m[1]! : null;
}

const f = (attribute: string, value: string | number): CampoPjsip => ({ attribute, value: String(value) });

function hostDoServidor(t: TroncoSip): string {
  return t.porta === 5060 ? t.servidor : `${t.servidor}:${t.porta}`;
}

/**
 * Tronco = autenticação + AOR + endpoint + registro, todos com o mesmo id.
 *
 * Cada campo que não é o default do Asterisk está aqui por uma medida da prova
 * de conceito (spec 20 §1): `rtp_symmetric`/`force_rport`/`rewrite_contact` são
 * o que fez o áudio voltar atrás de NAT sem publicar porta SIP; `qualify` de
 * 25 s mantém o mapeamento do NAT aberto para a INVITE da operadora chegar;
 * `line=yes` + `endpoint` fazem a ligação recebida casar com ESTE tronco mesmo
 * quando dois números da mesma operadora chegam do mesmo IP.
 *
 * Quem chama garante que o tronco passou por `problemaDoTronco` — os valores
 * vão crus para campos PJSIP, e alguns deles (o `contact` da AOR) são listas.
 */
export function objetosDoTronco(t: TroncoSip): ObjetoPjsip[] {
  const id = idDoTronco(t.id);
  const transporte = `transport-${t.transporte}`;
  const host = hostDoServidor(t);
  return [
    {
      tipo: "auth",
      id,
      campos: [f("auth_type", "userpass"), f("username", t.usuario), f("password", t.senha)],
    },
    {
      tipo: "aor",
      id,
      campos: [f("contact", `sip:${host};transport=${t.transporte}`), f("qualify_frequency", 25)],
    },
    {
      tipo: "endpoint",
      id,
      campos: [
        f("transport", transporte),
        f("context", "de-tronco"),
        // O tronco NÃO se identifica pelo `From`. O padrão do Asterisk é
        // `identify_by=username,ip`, e o tronco não tem `auth` de entrada (só
        // `outbound_auth`): medido em 2026-09-28 num Asterisk 20 (Alpine 3.22)
        // com exatamente estes objetos, uma INVITE forjada com
        // `From: <sip:tronco-<id>@qualquer>` casou este endpoint pelo nome, foi
        // atendida em `de-tronco` e o `P-Asserted-Identity` inventado virou o
        // número do cliente (`trust_id_inbound=yes`, abaixo). Com `identify_by=ip`
        // e nenhum objeto `identify`, a mesma INVITE leva "No matching endpoint
        // found" / 401. A ligação de verdade não depende disso: casa pelo
        // identificador `line` do registro (ver `line`/`endpoint` na registration),
        // que não tem nome e roda antes de todos — medido na VPS no mesmo dia, uma
        // recebida real da operadora (INVITE `sip:…;line=aqsytoa`, vinda do IP da
        // operadora) caiu em `tronco-<id>` com esta linha no lugar
        // (.superpowers/evidence/telefonia/identificacao-tronco-vps-2026-09-28.log).
        f("identify_by", "ip"),
        f("disallow", "all"),
        f("allow", "alaw,ulaw"),
        f("outbound_auth", id),
        f("aors", id),
        f("from_user", t.usuario),
        f("from_domain", t.servidor),
        f("direct_media", "no"),
        f("rtp_symmetric", "yes"),
        f("force_rport", "yes"),
        f("rewrite_contact", "yes"),
        f("dtmf_mode", "rfc4733"),
        f("trust_id_inbound", "yes"),
        f("send_rpid", "no"),
        f("send_pai", "no"),
        f("rtp_timeout", 120),
      ],
    },
    {
      tipo: "registration",
      id,
      campos: [
        f("transport", transporte),
        f("outbound_auth", id),
        f("server_uri", `sip:${host};transport=${t.transporte}`),
        f("client_uri", `sip:${t.usuario}@${t.servidor}`),
        f("contact_user", t.usuario),
        f("expiration", 300),
        f("retry_interval", 30),
        f("forbidden_retry_interval", 300),
        f("fatal_retry_interval", 300),
        f("max_retries", 100000),
        f("auth_rejection_permanent", "no"),
        f("line", "yes"),
        f("endpoint", id),
      ],
    },
  ];
}

export type ProblemaDoTronco = "servidor_invalido" | "usuario_invalido" | "porta_invalida";

/**
 * `null` quando o tronco pode ir para o Asterisk. A MESMA régua da rota que
 * cadastra (`conta-sip.ts`), aplicada de novo aqui porque a linha do banco
 * também é gravável pela REST, sem passar pelo Zod da rota — e o worker empurra
 * o que estiver lá.
 */
export function problemaDoTronco(t: Pick<TroncoSip, "servidor" | "usuario" | "porta">): ProblemaDoTronco | null {
  if (!servidorSipValido(t.servidor)) return "servidor_invalido";
  if (!usuarioSipValido(t.usuario)) return "usuario_invalido";
  if (!portaSipValida(t.porta)) return "porta_invalida";
  return null;
}

/**
 * O destino da perna da operadora na ligação de saída:
 * `PJSIP/<prefixo><número>@tronco-<id>`.
 *
 * O número chega aqui já julgado pela política antifraude
 * (`lib/telefonia/numero.ts`), SEM prefixo — o que o atendente digitou nunca
 * decide o prefixo. O prefixo vem do banco (`channel_sessions.sip_dial_prefix`),
 * e é conferido de novo aqui pela mesma régua do CHECK e do Zod
 * (`prefixoDeDiscagemValido`): a coluna também é gravável fora da rota, e este
 * texto vai cru para o Asterisk, onde um `@` ou um `&` mudaria para onde se disca.
 * Prefixo fora da régua não vira destino nenhum.
 *
 * Não entra em `problemaDoTronco` de propósito: o prefixo não faz parte do que a
 * sincronização empurra (nem do hash que decide reenviar), e um prefixo ruim não
 * pode derrubar o REGISTRO — é ele que faz a ligação recebida chegar.
 */
export function enderecoDeSaida(
  tronco: { id: string; prefixo: string | null },
  discar: string,
): { ok: true; endpoint: string } | { ok: false; problema: "prefixo_invalido" | "numero_invalido" } {
  const prefixo = tronco.prefixo ?? "";
  if (prefixo !== "" && !prefixoDeDiscagemValido(prefixo)) return { ok: false, problema: "prefixo_invalido" };
  // A mesma defesa para o número: só dígitos, DDD + número, como `numeroParaLigar` devolve.
  if (!/^[0-9]{10,11}$/.test(discar)) return { ok: false, problema: "numero_invalido" };
  return { ok: true, endpoint: `PJSIP/${prefixo}${discar}@${idDoTronco(tronco.id)}` };
}

export interface RamalSip {
  userId: string;
  senha: string;
  nome: string;
}

/**
 * Ramal do navegador (WebRTC sobre WSS). `context=de-ramal` só entrega ao
 * Stasis: com a senha do ramal não se disca para número nenhum sem uma
 * `voice_calls` de saída criada pela API para ESTE atendente (spec 20 §4.1).
 * Até três abas registradas; a mais nova derruba a mais velha além disso.
 */
export function objetosDoRamal(r: RamalSip): ObjetoPjsip[] {
  const id = idDoRamal(r.userId);
  const nome = r.nome.replace(/["\\\r\n]/g, "").slice(0, 60) || "Atendente";
  return [
    { tipo: "auth", id, campos: [f("auth_type", "userpass"), f("username", id), f("password", r.senha)] },
    { tipo: "aor", id, campos: [f("max_contacts", 3), f("remove_existing", "yes"), f("qualify_frequency", 0)] },
    {
      tipo: "endpoint",
      id,
      campos: [
        f("transport", "transport-ws"),
        f("context", "de-ramal"),
        f("disallow", "all"),
        f("allow", "opus,alaw,ulaw"),
        f("webrtc", "yes"),
        f("auth", id),
        f("aors", id),
        f("dtmf_mode", "rfc4733"),
        f("direct_media", "no"),
        f("callerid", `"${nome}" <${id}>`),
        // Aba fechada no meio da ligação não manda BYE, e o WebSocket que cai não
        // derruba o canal: sem áudio chegando por 30 s, o Asterisk desliga — e o
        // controlador fecha a ligação do outro lado (medido na prova pela tela:
        // sem isto o cliente ficou 4 min pendurado numa ponte com ninguém).
        f("rtp_timeout", 30),
      ],
    },
  ];
}

/** Ordem de gravação (quem é referenciado vem antes) e de remoção (o inverso). */
export const ORDEM_DE_GRAVACAO: ObjetoPjsip["tipo"][] = ["auth", "aor", "endpoint", "registration"];
