"use client";
/**
 * A lista de times — ativos em cima, arquivados no fim.
 *
 * Arquivado continua na tela porque arquivar é REVERSÍVEL e a única forma de
 * desfazer é encontrar o time. Esconder o que se arquivou por engano
 * transformaria um clique errado em suporte.
 */
import { useState } from "react";

import { EditorDeTime } from "@/components/times/EditorDeTime";
import { useTimes } from "@/components/times/useTimes";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import { Plus } from "@/lib/ui/icons";

export function PainelDeTimes() {
  const t = useT();
  const { data, isLoading, isError } = useTimes();
  /** Rascunhos só existem aqui: um time sem linha no banco não tem id. */
  const [rascunhos, setRascunhos] = useState<number[]>([]);

  const times = data?.data.times ?? [];
  const membros = data?.data.membros ?? [];
  const ativos = times.filter((x) => !x.archived_at);
  const arquivados = times.filter((x) => x.archived_at);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <Card className="p-4 text-sm text-muted-foreground">
        {t("Não foi possível carregar os times. Recarregue a página.")}
      </Card>
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4" data-testid="painel-de-times">
      {ativos.length === 0 && rascunhos.length === 0 ? (
        <Card className="space-y-2 p-4">
          <h2 className="text-sm font-semibold">{t("Nenhum time ainda")}</h2>
          <p className="text-sm text-muted-foreground">
            {t(
              "Um time é um setor que recebe conversa: Financeiro, Suporte, Vendas. Com times, o agente de IA encaminha cada cliente para quem sabe responder, e o atendente vê só a fila dele.",
            )}
          </p>
        </Card>
      ) : null}

      {ativos.map((x) => (
        <EditorDeTime key={x.id} time={x} membros={membros} />
      ))}

      {rascunhos.map((n) => (
        <EditorDeTime
          key={`rascunho-${n}`}
          time={null}
          membros={membros}
          aoDescartar={() => setRascunhos((r) => r.filter((x) => x !== n))}
        />
      ))}

      <div>
        <Button type="button" onClick={() => setRascunhos((r) => [...r, Date.now()])}>
          <Plus size={16} className="mr-1" /> {t("Novo time")}
        </Button>
      </div>

      {arquivados.length > 0 ? (
        <section className="space-y-3 border-t pt-4">
          <h2 className="text-sm font-semibold text-muted-foreground">{t("Arquivados")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Time arquivado não recebe conversa nova, mas continua nomeando as conversas que já passaram por ele.",
            )}
          </p>
          {arquivados.map((x) => (
            <EditorDeTime key={x.id} time={x} membros={membros} />
          ))}
        </section>
      ) : null}
    </div>
  );
}
