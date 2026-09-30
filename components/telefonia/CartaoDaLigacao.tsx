"use client";
/**
 * A ligação DENTRO da conversa (spec 20 §2.4): o registro que o worker grava
 * como mensagem de sistema com `metadata.voice_call`. Centralizado, como os
 * marcadores de dia — não é fala do cliente nem da empresa, é um fato.
 *
 * O texto é montado aqui a partir do metadado, e não lido do `body`: o `body`
 * existe para a prévia da lista e para busca, e está em português; a tela
 * precisa falar o idioma de quem a usa.
 *
 * Fase 2 (desenho §6.6): embaixo da pílula, o que a URA fez — o menu, a tecla e
 * o time para onde a ligação foi, ou que o cliente desligou no menu — e se ele
 * ouviu o aviso de instabilidade do time. A ligação sem nada disso (a da fase 1,
 * e a do número que toca direto no time) fica exatamente como era.
 *
 * Gravação (F3): a linha da gravação, quando a ligação foi gravada — preparando,
 * "Ouvir a gravação", não salva, ou apagada pela retenção. Ouvir pede a URL à
 * rota da ESCUTA AUDITADA (cada pedido é uma linha na auditoria) só no clique:
 * abrir a conversa não conta como escuta. Quem não alcança o piso de papel
 * (`voice.recording.listen`) vê que a ligação foi gravada, sem o botão.
 */
import { format } from "date-fns";
import { useState } from "react";

import { PhoneIncoming, PhoneOutgoing, PhoneX, Play, X } from "@/lib/ui/icons";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { gravacaoDaLigacao, type GravacaoDaLigacao } from "@/lib/telefonia/gravacao";
import { fraseDoElo } from "@/lib/telefonia/texto-da-transferencia";
import {
  MOTIVO_FORA_DO_HORARIO,
  menuDaLigacao,
  transferenciasDaLigacao,
  type MenuDaLigacao,
  type TransferenciaDaLigacao,
} from "@/lib/telefonia/vocabulario";

export interface MetadadoDaLigacao {
  id: string;
  direcao: "inbound" | "outbound";
  desfecho: "atendida" | "perdida" | "sem_resposta" | "recusada_pela_rede";
  duracao_ms: number | null;
  atendente_nome?: string | null;
  /** Por que terminou (`voice_calls.end_reason`). Só `after_hours` muda o cartão. */
  motivo?: string | null;
  /** O que a URA fez, quando o número tocava um menu (fase 2) — lido por `menuDaLigacao`. */
  menu?: MenuDaLigacao | null;
  /** O cliente ouviu o aviso de instabilidade do time até o fim. */
  ouviu_aviso?: boolean;
  /** A gravação (F3), lida por `gravacaoDaLigacao`; ausente = não gravada. */
  gravacao?: GravacaoDaLigacao | null;
  /** A corrente de transferências (v2), lida por `transferenciasDaLigacao`; vazia = não houve. */
  transferencias?: TransferenciaDaLigacao[];
}

export function ligacaoDaMensagem(metadata: unknown): MetadadoDaLigacao | null {
  const v = (metadata as { voice_call?: unknown } | null)?.voice_call as Partial<MetadadoDaLigacao> | undefined;
  if (!v || typeof v.id !== "string" || (v.direcao !== "inbound" && v.direcao !== "outbound")) return null;
  // Os campos da fase 2 passam pelo leitor: o jsonb é aberto, e o cartão não
  // pode contar uma história que o registro não sustenta.
  return {
    ...(v as MetadadoDaLigacao),
    motivo: typeof v.motivo === "string" ? v.motivo : null,
    menu: menuDaLigacao(v.menu),
    ouviu_aviso: v.ouviu_aviso === true,
    gravacao: gravacaoDaLigacao(v.gravacao),
    transferencias: transferenciasDaLigacao(v.transferencias),
  };
}

function duracao(ms: number | null): string | null {
  if (!ms || ms < 1000) return null;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Troca `{menu}`, `{tecla}` e `{time}` numa passada só, por função: os nomes vêm
 * do cadastro, e um `$&` no valor (ou um `{time}` no nome do menu) sairia
 * deturpado com `replace` de string ou com trocas em sequência.
 */
function preencher(modelo: string, valores: { menu: string; tecla: string; time: string }): string {
  return modelo.replace(/\{(menu|tecla|time)\}/g, (_, chave: "menu" | "tecla" | "time") => valores[chave]);
}

/** O `data-ligacao-menu` do cartão: o desfecho do vocabulário, ou o que houve sem ele. */
type SituacaoDoMenu = NonNullable<MenuDaLigacao["desfecho"]> | "desligou" | "interrompida";

/** A frase de leigo do que a URA fez. Cada frase é um `t()` literal: o guarda de i18n confere o espanhol. */
function oQueAUraFez(menu: MenuDaLigacao, t: (texto: string) => string): { situacao: SituacaoDoMenu; texto: string } {
  const valores = { menu: menu.nome ?? t("do telefone"), tecla: menu.tecla ?? "", time: menu.time_nome ?? "" };
  if (menu.desfecho === null) {
    return menu.desligou
      ? { situacao: "desligou", texto: preencher(t("Desligou no menu {menu}, antes de escolher"), valores) }
      : { situacao: "interrompida", texto: preencher(t("A ligação terminou no menu {menu}, antes de escolher"), valores) };
  }
  let acao: string;
  let destino: string;
  switch (menu.desfecho) {
    case "chosen":
      acao = menu.tecla ? t("No menu {menu}, digitou {tecla}") : t("No menu {menu}, escolheu uma opção");
      destino = t("e foi para o time {time}");
      break;
    case "default_no_input":
      acao = t("No menu {menu}, não digitou nada");
      destino = t("e foi para o time padrão, {time}");
      break;
    case "default_invalid":
      acao = t("No menu {menu}, digitou uma tecla que não existe");
      destino = t("e foi para o time padrão, {time}");
      break;
    default: {
      const _nunca: never = menu.desfecho;
      return _nunca;
    }
  }
  // Sem o nome do time (registro malformado), a frase para na tecla: melhor que um time em branco.
  const texto = menu.time_nome ? `${acao} ${destino}` : acao;
  return { situacao: menu.desfecho, texto: preencher(texto, valores) };
}

/**
 * O id da ligação vem do metadado da mensagem — e a URL da escuta é montada com
 * ele: só uuid vira pedido (achado da revisão de segurança). O resto vê "Ligação
 * gravada", sem botão.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** O que a linha da gravação está fazendo agora, na tela. */
type Escuta = { fase: "parada" } | { fase: "pedindo" } | { fase: "tocando"; url: string } | { fase: "erro" };

/**
 * A linha da gravação. A URL assinada vale 10 min: se o `<audio>` falha (URL
 * vencida, rede), a linha volta ao botão, e um clique pede uma nova — que é
 * outra escuta auditada, como deve ser.
 */
function LinhaDaGravacao({
  vcId,
  gravacao,
  podeOuvir,
}: {
  vcId: string;
  gravacao: GravacaoDaLigacao;
  podeOuvir: boolean;
}) {
  const t = useT();
  const [escuta, setEscuta] = useState<Escuta>({ fase: "parada" });
  const classe = "max-w-full px-4 text-center text-xs leading-snug text-muted-foreground";

  if (gravacao.situacao === "processando") {
    return (
      <p className={classe} data-ligacao-gravacao="processando">
        {t("Preparando a gravação…")}
      </p>
    );
  }
  if (gravacao.situacao === "falhou") {
    return (
      <p className={classe} data-ligacao-gravacao="falhou">
        {t("A gravação desta ligação não foi salva.")}
      </p>
    );
  }
  if (gravacao.situacao === "expirada") {
    return (
      <p className={classe} data-ligacao-gravacao="expirada">
        {t("Gravação apagada pelo prazo de guarda.")}
      </p>
    );
  }
  if (!podeOuvir || !UUID.test(vcId)) {
    return (
      <p className={classe} data-ligacao-gravacao="pronta">
        {t("Ligação gravada")}
      </p>
    );
  }

  const tempo = duracao(gravacao.duracao_ms);
  const ouvir = async () => {
    setEscuta({ fase: "pedindo" });
    try {
      const r = await apiClient.get<{ data: { url: string } }>(
        `/api/v1/telefonia/chamadas/${encodeURIComponent(vcId)}/gravacao`,
      );
      setEscuta({ fase: "tocando", url: r.data.url });
    } catch {
      setEscuta({ fase: "erro" });
    }
  };

  if (escuta.fase === "tocando") {
    return (
      <div className="flex w-full max-w-sm flex-col items-center gap-1 px-4" data-ligacao-gravacao="tocando">
        <audio
          controls
          autoPlay
          preload="auto"
          src={escuta.url}
          className="h-9 w-full"
          aria-label={t("Gravação da ligação")}
          onError={() => setEscuta({ fase: "erro" })}
        />
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setEscuta({ fase: "parada" })}
        >
          <X size={12} aria-hidden /> {t("Fechar o player")}
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-0.5" data-ligacao-gravacao="pronta">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60"
        disabled={escuta.fase === "pedindo"}
        onClick={() => void ouvir()}
        data-ouvir-gravacao
      >
        <Play size={12} weight="fill" aria-hidden />
        {escuta.fase === "pedindo" ? t("Abrindo a gravação…") : t("Ouvir a gravação")}
        {tempo ? <span className="tabular-nums text-muted-foreground">· {tempo}</span> : null}
      </button>
      {escuta.fase === "erro" ? (
        <p className={classe} role="alert">
          {t("Não foi possível abrir a gravação. Tente de novo.")}
        </p>
      ) : null}
    </div>
  );
}

export function CartaoDaLigacao({
  ligacao,
  em,
  podeOuvirGravacao = false,
}: {
  ligacao: MetadadoDaLigacao;
  em: string;
  /** O piso de papel de `voice.recording.listen` (quem chama sabe o papel; o cartão não). */
  podeOuvirGravacao?: boolean;
}) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const recebida = ligacao.direcao === "inbound";
  const atendida = ligacao.desfecho === "atendida";
  const foraDoHorario = recebida && !atendida && ligacao.motivo === MOTIVO_FORA_DO_HORARIO;
  const titulo = recebida
    ? atendida
      ? t("Ligação recebida")
      : foraDoHorario
        ? t("Ligação fora do horário")
        : t("Ligação perdida")
    : atendida
      ? t("Ligação feita")
      : ligacao.desfecho === "recusada_pela_rede"
        ? t("Ligação não completada")
        : t("Ligação sem resposta");
  const Icone = !atendida ? PhoneX : recebida ? PhoneIncoming : PhoneOutgoing;
  // A mesma régua da hora de cada balão (MessageBubble): 24 h, no idioma do app.
  const hora = format(new Date(em), "HH:mm", { locale: localeDaData });
  const tempo = duracao(ligacao.duracao_ms);
  const ura = ligacao.menu ? oQueAUraFez(ligacao.menu, t) : null;

  return (
    <div className="flex flex-col items-center gap-0.5 py-1" data-ligacao={ligacao.desfecho}>
      <div
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${
          atendida ? "border-border bg-muted/50 text-foreground" : "border-destructive/30 bg-destructive/5 text-destructive"
        }`}
      >
        <Icone size={14} weight="bold" aria-hidden />
        <span className="font-medium" data-ligacao-titulo>
          {titulo}
        </span>
        {ligacao.atendente_nome && atendida ? (
          <span className="text-muted-foreground">
            · {recebida ? t("atendida por") : t("por")} {ligacao.atendente_nome}
          </span>
        ) : null}
        {tempo ? <span className="tabular-nums text-muted-foreground">· {tempo}</span> : null}
        <span className="tabular-nums text-muted-foreground">· {hora}</span>
      </div>
      {ura || ligacao.ouviu_aviso ? (
        // Fora da pílula, e não dentro dela: a frase é longa, e uma pílula que
        // quebra em duas linhas vira um borrão no chat estreito.
        <p className="max-w-full px-4 text-center text-xs leading-snug text-muted-foreground" data-ligacao-ura>
          {ura ? <span data-ligacao-menu={ura.situacao}>{ura.texto}</span> : null}
          {ura && ligacao.ouviu_aviso ? " · " : null}
          {ligacao.ouviu_aviso ? <span data-ligacao-ouviu-aviso>{t("Ouviu o aviso de instabilidade")}</span> : null}
        </p>
      ) : null}
      {(ligacao.transferencias ?? []).length > 0 ? (
        <ul className="max-w-full px-4 text-center text-xs leading-snug text-muted-foreground" data-ligacao-transferencias>
          {(ligacao.transferencias ?? []).map((e, i) => {
            const f = fraseDoElo(e);
            const alguem = t("alguém");
            const texto = t(f.modelo)
              .replaceAll("{de}", f.de ?? alguem)
              .replaceAll("{para}", f.para ?? alguem)
              .replaceAll("{quem}", f.quem ?? alguem);
            return (
              <li key={i} data-ligacao-transferencia={e.desfecho ?? "aberta"}>
                {texto}
              </li>
            );
          })}
        </ul>
      ) : null}
      {ligacao.gravacao ? (
        <LinhaDaGravacao vcId={ligacao.id} gravacao={ligacao.gravacao} podeOuvir={podeOuvirGravacao} />
      ) : null}
    </div>
  );
}
