"use client";
/**
 * Um time de atendimento: o cartão que o RESUME e o formulário que o EDITA.
 *
 * O cartão é a única tela do produto que consegue explicar por que um time
 * parou de receber conversa. Três estados cabem aqui, e os três têm causa
 * diferente — aberto, fechado por horário, e agenda ILEGÍVEL. O terceiro é o que
 * justifica este componente existir em vez de uma lista simples: ver
 * `AvisoDeHorarioInvalido` abaixo.
 *
 * O formulário salva NOME, SLUG, "quando usar", HORÁRIO e MEMBROS num gesto só,
 * porque o backend salva num gesto só (`fn_save_attendance_team` é atômica). Um
 * formulário por campo daria ao gestor a impressão de que dá para trocar os
 * membros sem mexer no horário — e a RPC recebe os dois de qualquer forma.
 */
import { useMemo, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { timeDeAtendimentoSchema, type ScheduleWindow } from "@/lib/schemas/routing";
import { lerAgenda } from "@/lib/times/agenda";
import type { TimeDoCatalogo } from "@/lib/times/catalogo";
import { slugDoTime } from "@/lib/times/slug";
import { Archive, ArrowsClockwise, PencilSimple, Warning } from "@/lib/ui/icons";

import { EditorDeJanelas, resumoDeJanelas } from "./EditorDeJanelas";
import { useArquivarTime, useSalvarTime, type MembroAlocavel } from "./useTimes";

/**
 * ⚠️ O ÚNICO LEITOR DE `horario_invalido` QUE PODE DIZER O PORQUÊ.
 *
 * A decisão do produto é "agenda ilegível = time FECHADO e VISÍVEL". A metade
 * "fechado" mora no roteamento (`lerAgenda` devolve `valida: false` e
 * `carregarTimes` grava `aberto_agora: false`); a metade "visível" tem duas
 * pontas — o aviso da Central, que diz que a conversa está parada, e este
 * cartão, que é a única tela onde dá para CONSERTAR.
 *
 * Sem esta faixa, um time com agenda ilegível apenas sumiria do "aberto agora",
 * sem explicação: o campo `horario_invalido` nasceria sem leitor, que é a forma
 * "campo sem consumidor" do anti-pattern nº 3 do CLAUDE.md.
 */
function AvisoDeHorarioInvalido() {
  const t = useT();
  return (
    <p
      data-testid="aviso-horario-invalido"
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-50/60 p-3 text-xs dark:bg-amber-900/10"
    >
      <Warning size={16} className="mt-0.5 shrink-0 text-amber-600" />
      <span>
        {t(
          "O horário deste time está inválido e ninguém está recebendo por ele. Reconfigure o horário abaixo.",
        )}
      </span>
    </p>
  );
}

function Selo({ time }: { time: TimeDoCatalogo }) {
  const t = useT();
  if (time.archived_at) return <Badge variant="outline">{t("Arquivado")}</Badge>;
  if (time.horario_invalido) return <Badge variant="destructive">{t("Horário inválido")}</Badge>;
  if (time.aberto_agora) return <Badge>{t("Aberto agora")}</Badge>;
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {t("Fechado agora")}
    </Badge>
  );
}

export function EditorDeTime({
  time,
  membros,
  aoDescartar,
}: {
  /** `null` = time novo, ainda sem linha no banco. */
  time: TimeDoCatalogo | null;
  membros: MembroAlocavel[];
  /** Só o rascunho tem: descarta o cartão sem salvar nada. */
  aoDescartar?: () => void;
}) {
  const t = useT();
  const salvar = useSalvarTime();
  const arquivar = useArquivarTime();
  const novo = time === null;

  const inicial = useMemo(() => {
    const { agenda } = lerAgenda(time?.schedule);
    return {
      nome: time?.name ?? "",
      slug: time?.slug ?? "",
      descricao: time?.description ?? "",
      timezone: agenda.timezone,
      windows: agenda.windows,
      userIds: time?.user_ids ?? [],
      teto: time?.max_concurrent != null ? String(time.max_concurrent) : "",
    };
  }, [time]);

  const [aberto, setAberto] = useState(novo);
  const [nome, setNome] = useState(inicial.nome);
  const [slug, setSlug] = useState(inicial.slug);
  /**
   * O slug PARA de seguir o nome assim que a pessoa o edita — e já nasce solto
   * num time que existe. Renomear "Financeiro" para "Financeiro e cobrança"
   * reescreveria um identificador que alguém escolheu de propósito, e é ele que
   * o agente de IA usa para escolher o destino.
   */
  const [slugTocado, setSlugTocado] = useState(!novo);
  const [descricao, setDescricao] = useState(inicial.descricao);
  const [timezone, setTimezone] = useState(inicial.timezone);
  const [windows, setWindows] = useState<ScheduleWindow[]>(inicial.windows);
  const [userIds, setUserIds] = useState<string[]>(inicial.userIds);
  /** Texto, não número: campo vazio é "sem limite", e `0` digitado não pode virar isso em silêncio. */
  const [teto, setTeto] = useState(inicial.teto);

  /** Reabrir relê as props: outro gestor pode ter salvado enquanto isto estava fechado. */
  function abrir() {
    setNome(inicial.nome);
    setSlug(inicial.slug);
    setSlugTocado(!novo);
    setDescricao(inicial.descricao);
    setTimezone(inicial.timezone);
    setWindows(inicial.windows);
    setUserIds(inicial.userIds);
    setTeto(inicial.teto);
    setAberto(true);
  }

  const payload = {
    id: time?.id ?? null,
    name: nome.trim(),
    slug,
    description: descricao.trim(),
    schedule: { timezone, windows },
    user_ids: userIds,
    // Vazio = sem teto. Qualquer outra coisa vai ao schema como número, e é ele
    // quem recusa zero, negativo e texto — o botão Salvar apaga junto.
    max_concurrent: teto.trim() === "" ? null : Number(teto),
  };
  const conferido = timeDeAtendimentoSchema.safeParse(payload);
  const erroDeTeto = teto.trim() !== "" && !/^[1-9]\d{0,3}$/.test(teto.trim());
  const erroDeSlug = slug.length > 0 && !/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(slug);

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    if (!conferido.success) return;
    salvar.mutate(conferido.data, {
      onSuccess: () => {
        setAberto(false);
        aoDescartar?.();
      },
    });
  }

  return (
    <Card className="space-y-4 p-4" data-testid={novo ? "time-novo" : `time-${time.slug}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{novo ? t("Novo time") : time.name}</h3>
            {novo ? null : (
              <>
                <code className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {time.slug}
                </code>
                <Selo time={time} />
              </>
            )}
          </div>
          {novo ? null : (
            <p className="text-xs text-muted-foreground">
              {time.user_ids.length === 1
                ? t("1 pessoa neste time")
                : `${time.user_ids.length} ${t("pessoas neste time")}`}
              {" · "}
              {lerAgenda(time.schedule).agenda.windows.length === 0
                ? t("atende a qualquer hora")
                : resumoDeJanelas(lerAgenda(time.schedule).agenda.windows, t)}
              {/* O teto à vista, sem abrir o time: é ele que explica por que uma
                  conversa está esperando com atendente online. */}
              {time.max_concurrent != null && (
                <span data-testid="resumo-do-teto">
                  {" · "}
                  {t("até")} {time.max_concurrent} {t("conversas por atendente")}
                </span>
              )}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {novo || aberto ? null : (
            <Button type="button" variant="outline" size="sm" onClick={abrir}>
              <PencilSimple size={16} className="mr-1" /> {t("Editar")}
            </Button>
          )}
          {novo ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={arquivar.isPending}
              onClick={() => arquivar.mutate({ id: time.id, arquivar: !time.archived_at })}
            >
              {time.archived_at ? (
                <>
                  <ArrowsClockwise size={16} className="mr-1" /> {t("Reativar")}
                </>
              ) : (
                <>
                  <Archive size={16} className="mr-1" /> {t("Arquivar")}
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {!novo && time.horario_invalido && !time.archived_at ? <AvisoDeHorarioInvalido /> : null}

      {aberto ? (
        <form onSubmit={enviar} className="space-y-4 border-t pt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`nome-${time?.id ?? "novo"}`}>{t("Nome do time")}</Label>
              <Input
                id={`nome-${time?.id ?? "novo"}`}
                value={nome}
                maxLength={60}
                placeholder={t("Ex.: Financeiro")}
                disabled={salvar.isPending}
                onChange={(e) => {
                  setNome(e.target.value);
                  if (!slugTocado) setSlug(slugDoTime(e.target.value));
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`slug-${time?.id ?? "novo"}`}>{t("Identificador")}</Label>
              <Input
                id={`slug-${time?.id ?? "novo"}`}
                value={slug}
                maxLength={40}
                disabled={salvar.isPending}
                onChange={(e) => {
                  setSlugTocado(true);
                  setSlug(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {erroDeSlug
                  ? t("Use apenas letras minúsculas, números e hífen.")
                  : t("É por este nome curto que o agente de IA chama o time.")}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`teto-${time?.id ?? "novo"}`}>{t("Limite de conversas simultâneas por atendente")}</Label>
            <Input
              id={`teto-${time?.id ?? "novo"}`}
              value={teto}
              inputMode="numeric"
              maxLength={4}
              placeholder={t("Sem limite")}
              className="max-w-[10rem]"
              disabled={salvar.isPending}
              data-testid="teto-do-time"
              onChange={(e) => setTeto(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {erroDeTeto
                ? t("Use um número inteiro a partir de 1, ou deixe em branco para não limitar.")
                : t("Com todos no limite, a conversa nova espera na fila do time até alguém ter vaga — não vai para quem já está cheio.")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`quando-${time?.id ?? "novo"}`}>{t("Quando usar")}</Label>
            <Textarea
              id={`quando-${time?.id ?? "novo"}`}
              value={descricao}
              maxLength={500}
              rows={3}
              disabled={salvar.isPending}
              onChange={(e) => setDescricao(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "O agente de IA lê isto para escolher o time. Escreva os assuntos: fatura, boleto, negociação de dívida.",
              )}
            </p>
          </div>

          <div className="space-y-1.5">
            <h4 className="text-sm font-medium">{t("Horário de atendimento")}</h4>
            <p className="text-xs text-muted-foreground">
              {t(
                "Fora do horário, a conversa espera na fila do time até o próximo turno. Sem nenhuma janela, o time atende a qualquer hora.",
              )}
            </p>
            <EditorDeJanelas
              timezone={timezone}
              windows={windows}
              onTimezone={setTimezone}
              onWindows={setWindows}
              idFuso={`fuso-${time?.id ?? "novo"}`}
              disabled={salvar.isPending}
              vazioDiz={t("Nenhuma janela — este time atende a qualquer hora.")}
            />
          </div>

          <div className="space-y-1.5">
            <h4 className="text-sm font-medium">{t("Quem atende por este time")}</h4>
            {membros.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  "Ninguém para alocar ainda. Convide atendentes em Equipe e volte aqui para distribuí-los.",
                )}
              </p>
            ) : (
              <div className="grid gap-1 sm:grid-cols-2">
                {membros.map((m) => (
                  <label
                    key={m.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-sm hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 accent-primary"
                      checked={userIds.includes(m.id)}
                      disabled={salvar.isPending}
                      onChange={(e) =>
                        setUserIds((atual) =>
                          e.target.checked
                            ? [...atual, m.id]
                            : atual.filter((x) => x !== m.id),
                        )
                      }
                    />
                    <span className="truncate">{m.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={salvar.isPending || !conferido.success}>
              {salvar.isPending ? t("Salvando…") : t("Salvar")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={salvar.isPending}
              onClick={() => {
                setAberto(false);
                if (novo) aoDescartar?.();
              }}
            >
              {t("Cancelar")}
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
