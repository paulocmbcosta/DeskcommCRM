"use client";
/**
 * Editor de janelas de horário — UM no repositório, dois donos.
 *
 * Nasceu dentro do `ScheduleDialog` de `app/app/team/_components/AttendantsClient.tsx`,
 * onde editava o horário de um ATENDENTE. A tela de Times precisa do mesmo
 * editor para o horário de um TIME — mesmo shape (`availabilityScheduleSchema`),
 * mesmo leitor (`lerAgenda`), mesma regra de elegibilidade (`isWithinSchedule`).
 *
 * Foi EXTRAÍDO, e não copiado, porque duas cópias divergem na primeira correção
 * de fuso: o campo de fuso é lido por `localMoment`, que LANÇA num fuso que não
 * existe — e o dono da agenda quebrada nunca fica elegível, sem que nada na tela
 * diga por quê (é o defeito medido no cabeçalho de `lib/tempo/fusos.ts`).
 * Consertar isso em um dos dois lugares e não no outro é como se produz a
 * metade que continua quebrada.
 *
 * É CONTROLADO de propósito: quem chama guarda `timezone` e `windows` e decide
 * quando salvar. O atendente salva ao fechar um diálogo; o time salva junto com
 * nome, slug e membros, num formulário só. Um editor com estado próprio
 * obrigaria os dois a sincronizar por efeito.
 */
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ScheduleWindow } from "@/lib/schemas/routing";
import { FUSOS_OFERECIDOS } from "@/lib/tempo/fusos";
import { Plus, Trash } from "@/lib/ui/icons";

/** `dow` é o índice: 0 = domingo, como em `Date.getDay()` e em `localMoment`. */
const DIAS_DA_SEMANA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

/**
 * "Seg 08:00–18:00, Ter 08:00–18:00" — a lista, sem a frase do caso vazio.
 *
 * O vazio fica com quem chama porque ele significa COISAS DIFERENTES em cada
 * tela: para o atendente é "não publicado" (a Agenda não oferece horário
 * nenhum); para o time é "atende a qualquer hora" (o roteamento não restringe).
 * Uma frase só aqui obrigaria uma das duas a mentir.
 */
export function resumoDeJanelas(
  windows: ScheduleWindow[],
  t: (texto: string) => string,
): string {
  return windows.map((w) => `${t(DIAS_DA_SEMANA[w.dow] ?? "")} ${w.start}–${w.end}`).join(", ");
}

export function EditorDeJanelas({
  timezone,
  windows,
  onTimezone,
  onWindows,
  vazioDiz,
  idFuso,
  disabled = false,
}: {
  timezone: string;
  windows: ScheduleWindow[];
  onTimezone: (fuso: string) => void;
  /** Recebe o atualizador, e não o valor: é o `setWindows` de quem chama. */
  onWindows: (atualiza: (ws: ScheduleWindow[]) => ScheduleWindow[]) => void;
  /** A frase do caso vazio, JÁ traduzida por quem chama. */
  vazioDiz: string;
  /** Sufixo do id do campo de fuso — duas agendas podem dividir uma tela. */
  idFuso: string;
  disabled?: boolean;
}) {
  const t = useT();

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={idFuso}>{t("Fuso horário")}</Label>
        {/* Mesma razão do painel anti-banimento, e aqui o custo é maior:
            este fuso é lido por `localMoment`, que LANÇA num fuso inexistente
            — e quem tem a agenda quebrada nunca fica elegível, sem que nada na
            tela diga por quê. */}
        <select
          id={idFuso}
          value={timezone}
          disabled={disabled}
          onChange={(e) => onTimezone(e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          {FUSOS_OFERECIDOS.map((f) => (
            <option key={f.codigo} value={f.codigo}>
              {f.rotulo} — {f.codigo}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        {windows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{vazioDiz}</p>
        ) : null}
        {windows.map((w, i) => (
          <div key={i} className="flex items-center gap-2">
            <Select
              value={String(w.dow)}
              disabled={disabled}
              onValueChange={(v) =>
                onWindows((ws) => ws.map((x, j) => (j === i ? { ...x, dow: Number(v) } : x)))
              }
            >
              <SelectTrigger className="w-[90px]" aria-label="Dia da semana">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIAS_DA_SEMANA.map((d, idx) => (
                  <SelectItem key={idx} value={String(idx)}>
                    {t(d)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="time"
              value={w.start}
              disabled={disabled}
              aria-label={t("Início")}
              onChange={(e) =>
                onWindows((ws) => ws.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))
              }
            />
            <span className="text-muted-foreground">–</span>
            <Input
              type="time"
              value={w.end}
              disabled={disabled}
              aria-label="Fim"
              onChange={(e) =>
                onWindows((ws) => ws.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))
              }
            />
            <Button
              // `type="button"` explícito: o editor agora também vive DENTRO de
              // um formulário (a tela de Times), onde botão sem tipo declarado
              // vira `submit` — remover uma janela salvaria o time inteiro.
              //
              // Sem sinal de maior-que no texto deste comentário: o gate
              // `controle-decorativo` casa a tag do botão de forma NÃO-GULOSA
              // até o primeiro fecha-tag, e um desses sinais aqui dentro
              // encerraria a tag antes do onClick — o botão correto seria
              // acusado de mudo.
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              aria-label="Remover janela"
              onClick={() => onWindows((ws) => ws.filter((_, j) => j !== i))}
            >
              <Trash size={18} />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onWindows((ws) => [...ws, { dow: 1, start: "08:00", end: "18:00" }])}
        >
          <Plus size={16} className="mr-1" /> {t("Adicionar janela")}
        </Button>
      </div>
    </div>
  );
}
