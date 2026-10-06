"use client";
/**
 * OS ASSUNTOS DE ENCERRAMENTO DE UM TIME (migration 0293).
 *
 * É a lista que o atendente vê na janela de encerramento quando o setor é este
 * time — e é dela que saem os números por assunto em Métricas. Quem cadastra é
 * quem administra, do jeito que o negócio fala: "Segunda via de boleto", não
 * "Financeiro › Cobrança › 2ª via".
 *
 * ARQUIVAR, NUNCA APAGAR. Atendimento encerrado aponta para o assunto, e o
 * número do mês passado não pode mudar porque alguém limpou a lista. Arquivado
 * fica à vista, no fim, pelo mesmo motivo dos times: a única forma de desfazer
 * é encontrá-lo.
 *
 * Fica FORA do formulário do time de propósito: salvar um assunto não pode
 * depender de salvar horário e membros, e um erro num não pode travar o outro.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import type { AssuntoCadastrado } from "@/lib/atendimento/assuntos";
import { NOME_DO_ASSUNTO_MAXIMO } from "@/lib/atendimento/encerramento";
import { Archive, ArrowsClockwise, PencilSimple, Plus } from "@/lib/ui/icons";

import { useAlterarAssunto, useAssuntosDoTime, useCriarAssunto } from "./useAssuntosDoTime";

export function AssuntosDoTime({ timeId, timeNome, timeSlug }: { timeId: string; timeNome: string; timeSlug: string }) {
  const t = useT();
  const lista = useAssuntosDoTime(timeId);
  const criar = useCriarAssunto(timeId);
  const alterar = useAlterarAssunto(timeId);
  const [novo, setNovo] = useState("");
  const [editando, setEditando] = useState<{ id: string; nome: string } | null>(null);

  const ativos = (lista.data ?? []).filter((a) => !a.archived);
  const arquivados = (lista.data ?? []).filter((a) => a.archived);
  const nomeNovo = novo.trim();

  function adicionar(e: React.FormEvent) {
    e.preventDefault();
    if (nomeNovo === "" || criar.isPending) return;
    criar.mutate(nomeNovo, { onSuccess: () => setNovo("") });
  }

  function renomear(e: React.FormEvent) {
    e.preventDefault();
    if (!editando) return;
    const nome = editando.nome.trim();
    if (nome === "") return;
    alterar.mutate({ id: editando.id, name: nome }, { onSuccess: () => setEditando(null) });
  }

  return (
    <Card className="space-y-3 p-4" data-testid={`assuntos-do-time-${timeSlug}`}>
      <div>
        <h4 className="text-sm font-medium">
          {t("Assuntos de encerramento")} · {timeNome}
        </h4>
        <p className="text-xs text-muted-foreground">
          {t(
            "É a lista que quem atende escolhe ao encerrar um atendimento deste setor. Os números por assunto em Métricas saem daqui.",
          )}
        </p>
      </div>

      {lista.isLoading ? (
        <Skeleton className="h-8 w-full" />
      ) : lista.isError ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-error-fg">{t("Não foi possível carregar os assuntos. Tente novamente.")}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void lista.refetch()}>
            {t("Tentar de novo")}
          </Button>
        </div>
      ) : (
        <>
          {ativos.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="assuntos-vazio">
              {t("Nenhum assunto ainda. Sem assunto cadastrado, este setor não aparece na janela de encerramento.")}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {ativos.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 px-3 py-1.5" data-testid="assunto-item" data-nome={a.name}>
                  {editando?.id === a.id ? (
                    <form onSubmit={renomear} className="flex min-w-0 flex-1 items-center gap-2">
                      <Input
                        autoFocus
                        aria-label={t("Nome do assunto")}
                        value={editando.nome}
                        maxLength={NOME_DO_ASSUNTO_MAXIMO}
                        onChange={(e) => setEditando({ id: a.id, nome: e.target.value })}
                        className="h-8"
                      />
                      <Button type="submit" size="sm" disabled={alterar.isPending || editando.nome.trim() === ""}>
                        {t("Salvar")}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setEditando(null)}>
                        {t("Cancelar")}
                      </Button>
                    </form>
                  ) : (
                    <>
                      <span className="min-w-0 truncate text-sm">{a.name}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          data-testid="assunto-renomear"
                          onClick={() => setEditando({ id: a.id, nome: a.name })}
                        >
                          <PencilSimple size={14} className="mr-1" /> {t("Renomear")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          data-testid="assunto-arquivar"
                          disabled={alterar.isPending}
                          onClick={() => alterar.mutate({ id: a.id, archived: true })}
                        >
                          <Archive size={14} className="mr-1" /> {t("Arquivar")}
                        </Button>
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={adicionar} className="flex items-center gap-2">
            <Input
              aria-label={t("Novo assunto")}
              data-testid="assunto-novo-nome"
              placeholder={t("Ex.: Segunda via de boleto")}
              value={novo}
              maxLength={NOME_DO_ASSUNTO_MAXIMO}
              onChange={(e) => setNovo(e.target.value)}
              className="h-9"
            />
            <Button type="submit" size="sm" data-testid="assunto-adicionar" disabled={nomeNovo === "" || criar.isPending}>
              <Plus size={14} className="mr-1" /> {criar.isPending ? t("Adicionando…") : t("Adicionar")}
            </Button>
          </form>

          {arquivados.length > 0 && <Arquivados assuntos={arquivados} onReativar={(id) => alterar.mutate({ id, archived: false })} ocupado={alterar.isPending} />}
        </>
      )}
    </Card>
  );
}

function Arquivados({
  assuntos,
  onReativar,
  ocupado,
}: {
  assuntos: AssuntoCadastrado[];
  onReativar: (id: string) => void;
  ocupado: boolean;
}) {
  const t = useT();
  return (
    <div className="space-y-1.5 border-t border-border pt-3" data-testid="assuntos-arquivados">
      <p className="text-xs font-medium text-muted-foreground">{t("Arquivados")}</p>
      <ul className="flex flex-wrap gap-2">
        {assuntos.map((a) => (
          <li key={a.id} className="flex items-center gap-1 rounded-full border border-border py-0.5 pl-3 pr-1 text-xs text-muted-foreground">
            <span className="max-w-48 truncate">{a.name}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              data-testid="assunto-reativar"
              disabled={ocupado}
              onClick={() => onReativar(a.id)}
            >
              <ArrowsClockwise size={12} className="mr-1" /> {t("Reativar")}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
