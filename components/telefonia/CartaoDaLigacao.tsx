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
 */
import { format } from "date-fns";

import { PhoneIncoming, PhoneOutgoing, PhoneX } from "@/lib/ui/icons";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { MOTIVO_FORA_DO_HORARIO, menuDaLigacao, type MenuDaLigacao } from "@/lib/telefonia/vocabulario";

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
      : { situacao: "interrompida", texto: preencher(t("A ligação terminou no menu {menu}, antes da escolha"), valores) };
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

export function CartaoDaLigacao({ ligacao, em }: { ligacao: MetadadoDaLigacao; em: string }) {
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
        <span className="font-medium">{titulo}</span>
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
        <p className="max-w-full px-4 text-center text-[11px] leading-snug text-muted-foreground" data-ligacao-ura>
          {ura ? <span data-ligacao-menu={ura.situacao}>{ura.texto}</span> : null}
          {ura && ligacao.ouviu_aviso ? " · " : null}
          {ligacao.ouviu_aviso ? <span data-ligacao-ouviu-aviso>{t("Ouviu o aviso de instabilidade")}</span> : null}
        </p>
      ) : null}
    </div>
  );
}
