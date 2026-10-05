"use client";

/**
 * DO QUE OS ATENDIMENTOS TRATARAM (migration 0293).
 *
 * Responde à pergunta que motivou a janela de encerramento: quais assuntos
 * geram mais atendimento, por setor, no dia e no mês.
 *
 * Três números que este painel NÃO esconde, porque são eles que dizem se dá
 * para confiar nos outros:
 *   · quantos encerramentos ficaram SEM assunto — com esse número alto, o
 *     ranking abaixo é uma amostra, não o todo;
 *   · de qual time eram os sem assunto — é onde falta cadastro ou hábito;
 *   · quantos de um assunto foram atendidos por OUTRO time que não o setor dele
 *     — é o cliente chegando ao lugar errado.
 *
 * Só gerente e administrador (a rota é manager+): é número de gestão.
 */
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import { useAssuntosMetrics } from "@/hooks/metrics/useAssuntosMetrics";
import { percentual } from "@/lib/metrics/assuntos";
import {
  PERIODOS_DE_ASSUNTOS,
  ROTULO_DO_PERIODO,
  intervaloDoPeriodo,
  type PeriodoDeAssuntos,
} from "@/lib/metrics/periodo-dos-assuntos";

export function AssuntosPanel() {
  const t = useT();
  const [periodo, setPeriodo] = useState<PeriodoDeAssuntos>("30d");
  // O intervalo é calculado no CLIQUE, e não a cada render: `new Date()` no
  // corpo mudaria a chave da consulta a cada milissegundo.
  const [intervalo, setIntervalo] = useState(() => intervaloDoPeriodo("30d", new Date()));
  const { data, isLoading, isError, refetch } = useAssuntosMetrics(intervalo);

  function escolher(p: PeriodoDeAssuntos) {
    setPeriodo(p);
    setIntervalo(intervaloDoPeriodo(p, new Date()));
  }

  return (
    <Card data-testid="painel-de-assuntos">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-base">{t("Assuntos dos atendimentos encerrados")}</CardTitle>
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("Período")}>
          {PERIODOS_DE_ASSUNTOS.map((p) => (
            <Button
              key={p}
              type="button"
              size="sm"
              variant={p === periodo ? "default" : "outline"}
              aria-pressed={p === periodo}
              data-testid={`periodo-${p}`}
              onClick={() => escolher(p)}
            >
              {t(ROTULO_DO_PERIODO[p])}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : isError || !data ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-destructive">{t("Não foi possível calcular os números por assunto.")}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void refetch()}>
              {t("Tentar de novo")}
            </Button>
          </div>
        ) : data.total === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="assuntos-sem-encerramentos">
            {t("Nenhum atendimento encerrado neste período.")}
          </p>
        ) : (
          <>
            <p className="text-sm" data-testid="assuntos-resumo">
              <span className="font-semibold tabular-nums">{data.total}</span>{" "}
              {data.total === 1 ? t("atendimento encerrado") : t("atendimentos encerrados")}
              {" · "}
              <span className="tabular-nums">{data.com_assunto}</span> {t("com assunto")} (
              {percentual(data.com_assunto, data.total)}%)
              {" · "}
              <span className="tabular-nums">{data.sem_assunto}</span> {t("sem assunto")}
            </p>

            {data.setores.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="assuntos-sem-registro">
                {t("Nenhum encerramento com assunto neste período.")}{" "}
                <Link href="/app/settings/teams" className="font-medium text-accent hover:underline">
                  {t("Cadastrar assuntos")}
                </Link>
              </p>
            ) : (
              data.setores.map((setor) => {
                const maior = Math.max(1, ...setor.assuntos.map((a) => a.total));
                return (
                  <section key={setor.id ?? "sem-setor"} className="flex flex-col gap-2" data-testid="assuntos-do-setor">
                    <h3 className="flex items-baseline justify-between gap-3 text-sm font-medium">
                      <span className="truncate">{setor.nome ?? t("Setor removido")}</span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {setor.total} · {percentual(setor.total, data.com_assunto)}%
                      </span>
                    </h3>
                    {setor.assuntos.map((a) => (
                      <div key={a.id} data-testid="assunto-contado" data-assunto={a.nome}>
                        <div className="flex items-center gap-3">
                          <span className="w-44 shrink-0 truncate text-sm" title={a.nome}>
                            {a.nome}
                          </span>
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary transition-[width]"
                              style={{ width: `${(a.total / maior) * 100}%` }}
                            />
                          </div>
                          <span className="w-20 shrink-0 text-right text-sm tabular-nums">
                            {a.total} · {percentual(a.total, setor.total)}%
                          </span>
                        </div>
                        {a.de_outro_time > 0 && (
                          <p className="pl-[11.75rem] text-xs text-muted-foreground" data-testid="de-outro-time">
                            {a.de_outro_time} {a.de_outro_time === 1 ? t("atendido por outro time") : t("atendidos por outro time")}
                          </p>
                        )}
                      </div>
                    ))}
                  </section>
                );
              })
            )}

            {data.sem_assunto > 0 && (
              <section className="flex flex-col gap-1 border-t pt-4" data-testid="sem-assunto-por-time">
                <h3 className="text-sm font-medium">
                  {t("Sem assunto")} · <span className="tabular-nums">{data.sem_assunto}</span>
                </h3>
                <p className="text-xs text-muted-foreground">
                  {t("Encerramentos em que ninguém informou o assunto, pelo time que estava atendendo.")}
                </p>
                <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {data.sem_assunto_por_time.map((time) => (
                    <li key={time.id ?? "sem-time"}>
                      {time.nome ?? t("Sem time")}: <span className="tabular-nums">{time.total}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
