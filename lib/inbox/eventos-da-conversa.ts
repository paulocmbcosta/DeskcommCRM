/**
 * O VOCABULÁRIO DA LINHA DO TEMPO DA CONVERSA (migration 0266).
 *
 * `conversation_events.type` é `text` SEM check constraint, de propósito — a
 * linha do tempo ganha tipo novo a cada feature, e um CHECK faria o `update.sh`
 * de um clone depender da ordem em que código e banco chegam. É a exceção de
 * vocabulário aberto que o CLAUDE.md documenta, e ela tem um preço: o
 * vocabulário vive SÓ aqui. Quem emite usa estas constantes, nunca string solta.
 *
 * Quem ESCREVE a maior parte dos eventos é o trigger
 * `fn_atendimento_acompanha_conversa`, no banco — os tipos abaixo espelham os
 * literais do corpo dele, e `tests/unit/eventos-da-conversa.test.ts` lê o
 * baseline para garantir que nenhum literal de lá fica sem rótulo aqui. Tipo
 * sem rótulo não quebra a tela (cai no genérico), mas vira uma linha que não
 * diz nada — o defeito que esta tela existe para acabar.
 */
export const TIPOS_DE_EVENTO_DA_CONVERSA = [
  "opened",
  "closed",
  "reopened",
  "team_changed",
  "assigned",
  "released",
  "handoff",
  "ai_paused",
  "ai_resumed",
  "snoozed",
] as const;

export type TipoDeEventoDaConversa = (typeof TIPOS_DE_EVENTO_DA_CONVERSA)[number];

export interface EventoDaConversa {
  id: string;
  type: string;
  actor_kind: "user" | "ai" | "system" | string;
  actor_user_id: string | null;
  actor_name: string | null;
  atendimento_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

/**
 * O TOM é o que a bolinha da linha diz antes de alguém ler o texto:
 *   entrada ... algo começou ou voltou a andar
 *   espera .... a conversa está na mão de ninguém em particular
 *   pessoa .... alguém assumiu ou agiu
 *   fim ....... o atendimento acabou
 *   neutro .... registro sem urgência
 */
export type TomDoEvento = "entrada" | "espera" | "pessoa" | "fim" | "neutro";

export interface EventoDescrito {
  titulo: string;
  detalhe: string | null;
  tom: TomDoEvento;
}

type Tradutor = (texto: string) => string;

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor.trim() : null;
}

/** Status terminal → a palavra que o atendente usa. */
const DESFECHO_DO_STATUS: Record<string, string> = {
  closed: "Conversa encerrada",
  resolved: "Conversa resolvida",
  archived: "Conversa arquivada",
};

/**
 * Transforma o evento cru numa linha legível.
 *
 * Pura e sem React: a mesma função serve a tela e o teste, e o `t` entra por
 * parâmetro para o rótulo sair no idioma de quem lê. Os NOMES (de pessoa e de
 * time) são dado, não texto de interface — entram por concatenação, nunca por
 * `t()`.
 */
export function descreverEventoDaConversa(evento: EventoDaConversa, t: Tradutor): EventoDescrito {
  const p = evento.payload ?? {};
  const ator = texto(evento.actor_name);
  const por = (frase: string) => (ator ? `${t(frase)} ${ator}.` : null);

  switch (evento.type) {
    case "opened": {
      const protocolo = texto(p.protocol);
      const retorno = p.retorno === true;
      return {
        titulo: retorno ? t("Novo atendimento aberto") : t("Conversa aberta"),
        detalhe: [
          retorno ? t("O cliente voltou a escrever.") : null,
          protocolo ? `${t("Protocolo")} ${protocolo}.` : null,
        ]
          .filter(Boolean)
          .join(" ") || null,
        tom: "entrada",
      };
    }
    case "closed":
      return {
        titulo: t(DESFECHO_DO_STATUS[texto(p.status) ?? "closed"] ?? "Conversa encerrada"),
        // `backfill`: encerramento de ANTES da linha do tempo existir (migration
        // 0268). O banco sabe QUANDO fechou, não POR QUEM — e dizer "automaticamente"
        // sobre uma conversa que alguém fechou à mão seria inventar o autor.
        detalhe:
          por("Por") ??
          (p.backfill === true ? null : evento.actor_kind === "system" ? t("Encerrada automaticamente.") : null),
        tom: "fim",
      };
    case "reopened":
      return {
        titulo: t("Conversa reaberta"),
        detalhe: [por("Por"), t("O protocolo continua o mesmo.")].filter(Boolean).join(" "),
        tom: "entrada",
      };
    case "team_changed": {
      const para = texto(p.to_team_name);
      const de = texto(p.from_team_name);
      if (!para) {
        return {
          titulo: t("Devolvida à fila geral"),
          detalhe: [de ? `${t("Saiu do time")} ${de}.` : null, por("Por")].filter(Boolean).join(" ") || null,
          tom: "espera",
        };
      }
      return {
        titulo: t("Transferida para a fila do time"),
        detalhe: [`${para}.`, ator ? `${t("Por")} ${ator}.` : t("Aguardando operador disponível.")].join(" "),
        tom: "espera",
      };
    }
    case "assigned": {
      const para = texto(p.to_user_name) ?? t("Atendente");
      const paraId = texto(p.to_user_id);
      const de = texto(p.from_user_name);
      // Três gestos diferentes chegam como a mesma troca de dono, e quem os
      // separa é QUEM fez: a própria pessoa (assumiu), outra (transferiu) ou
      // ninguém (o rodízio distribuiu).
      if (evento.actor_kind !== "user") {
        return {
          titulo: t("Distribuída automaticamente"),
          detalhe: `${para} ${t("recebeu a conversa pelo rodízio.")}`,
          tom: "pessoa",
        };
      }
      // Por ID, não por nome: dois atendentes podem se chamar "Ana".
      if (evento.actor_user_id !== null && evento.actor_user_id === paraId) {
        return { titulo: t("Atendimento assumido"), detalhe: `${para} ${t("assumiu a conversa.")}`, tom: "pessoa" };
      }
      return {
        titulo: t("Conversa transferida"),
        detalhe: [de ? `${t("De")} ${de} ${t("para")} ${para}.` : `${t("Para")} ${para}.`, por("Por")]
          .filter(Boolean)
          .join(" "),
        tom: "pessoa",
      };
    }
    case "released": {
      const de = texto(p.from_user_name);
      return {
        titulo: t("Conversa liberada"),
        detalhe: [de ? `${de} ${t("devolveu a conversa à fila.")}` : t("Voltou para a fila.")].join(" "),
        tom: "espera",
      };
    }
    case "handoff":
      return {
        titulo: t("Passada para atendimento humano"),
        detalhe: t("O atendimento automático chamou uma pessoa."),
        tom: "espera",
      };
    case "ai_paused":
      return { titulo: t("Atendimento automático pausado"), detalhe: por("Por"), tom: "neutro" };
    case "ai_resumed":
      return { titulo: t("Devolvida ao atendimento automático"), detalhe: por("Por"), tom: "neutro" };
    case "snoozed":
      return { titulo: t("Lembrete agendado"), detalhe: por("Por"), tom: "neutro" };
    default:
      // Tipo que esta versão da tela não conhece (banco mais novo que o código,
      // no meio de uma atualização). Mostra que ALGO aconteceu, sem inventar o quê.
      return { titulo: t("Atividade registrada"), detalhe: por("Por"), tom: "neutro" };
  }
}

/**
 * Atividades do NEGÓCIO (`crm_lead_activities`) que a linha do tempo da
 * conversa JÁ conta por conta própria. Entram juntas na mesma tela, e sem este
 * corte o mesmo gesto — assumir, transferir, liberar, pausar, passar para uma
 * pessoa — apareceria duas vezes, uma de cada fonte.
 *
 * Os valores são `source_module` dos dois emissores: `inbox.comando`
 * (`lib/inbox/atividade-de-comando.ts`) e `human-handoff`
 * (`lib/agent-engine/agent/human-handoff.ts`).
 */
export const ORIGENS_JA_CONTADAS_PELA_CONVERSA = ["inbox.comando", "human-handoff"] as const;

/** Uma atividade do negócio, como a linha do tempo a recebe. */
export interface AtividadeDoNegocio {
  id: string;
  type: string;
  source_module: string;
  performed_at: string;
  reason: string | null;
  actor_kind: string | null;
  performed_by_name: string | null;
}

export interface LinhaDoTempoDaConversa {
  eventos: EventoDaConversa[];
  atividades: AtividadeDoNegocio[];
  /** A leitura das atividades do negócio falhou: a tela DIZ, não finge lista vazia. */
  atividades_indisponiveis: boolean;
}

/** O atendimento como a tela o lê — histórico do contato e busca por protocolo. */
export interface AtendimentoResumo {
  id: string;
  conversation_id: string;
  protocol: string;
  started_at: string;
  closed_at: string | null;
  closed_status: string | null;
  closed_by_name: string | null;
  assigned_to_user_name: string | null;
  team_id: string | null;
  /** Por onde entrou: número ou nome do canal. */
  canal: string | null;
  /** Só na busca por protocolo: de quem é. */
  contato?: string | null;
}

/** Aberto enquanto `closed_at` é nulo — o status terminal só existe depois. */
export function rotuloDoAtendimento(a: Pick<AtendimentoResumo, "closed_at" | "closed_status">): string {
  if (!a.closed_at) return "Em andamento";
  if (a.closed_status === "resolved") return "Resolvida";
  if (a.closed_status === "archived") return "Arquivada";
  return "Fechada";
}
