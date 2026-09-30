"use client";
/**
 * O SELETOR DA TRANSFERÊNCIA (v2; desenho §12.5) — dentro do painel da ligação.
 *
 * Busca por nome ou ramal. As pessoas aparecem com a situação de agora (D17):
 * só a disponível pode ser escolhida — as outras ficam em cinza, com o motivo.
 * Os times aparecem com quantos estão livres, ou "fora do horário" (e aí não
 * podem ser escolhidos). Pessoa: [Transferir] e [Falar antes]; time: [Transferir].
 */
import { useMemo, useState } from "react";

import {
  ROTULO_DA_SITUACAO,
  casaComABusca,
  useDiretorio,
  type ColegaDoDiretorio,
  type TimeDoDiretorio,
} from "@/components/telefonia/useDiretorio";
import { useTelefonia } from "@/components/telefonia/TelefoniaContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { MagnifyingGlass, X } from "@/lib/ui/icons";

const ORDEM_DA_SITUACAO = ["disponivel", "em_ligacao", "em_pausa", "fora_do_horario", "offline"] as const;

export function TransferirLigacao({ onFechar }: { onFechar: () => void }) {
  const t = useT();
  const { transferir } = useTelefonia();
  const { diretorio, carregando } = useDiretorio(true);
  const [busca, setBusca] = useState("");
  const [enviando, setEnviando] = useState(false);

  const pessoas = useMemo<ColegaDoDiretorio[]>(
    () =>
      (diretorio?.pessoas ?? [])
        .filter((p) => !p.eu && casaComABusca(p, busca))
        .sort((a, b) => ORDEM_DA_SITUACAO.indexOf(a.situacao) - ORDEM_DA_SITUACAO.indexOf(b.situacao) || a.nome.localeCompare(b.nome)),
    [diretorio, busca],
  );
  const times = useMemo<TimeDoDiretorio[]>(
    () => (diretorio?.times ?? []).filter((x) => casaComABusca({ nome: x.nome, ramal: null }, busca)),
    [diretorio, busca],
  );

  const pedir = async (modo: "direta" | "consultada", para: { user_id: string } | { team_id: string }) => {
    setEnviando(true);
    const aceito = await transferir({ modo, para });
    setEnviando(false);
    if (aceito) onFechar();
  };

  return (
    <div data-telefonia="transferir" className="mt-3 rounded-lg border border-border bg-background p-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <MagnifyingGlass size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            autoFocus
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder={t("Nome ou ramal")}
            aria-label={t("Buscar pessoa ou time")}
            className="h-8 pl-7 text-sm"
          />
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("Fechar")} onClick={onFechar}>
          <X size={14} aria-hidden />
        </Button>
      </div>

      <div className="mt-2 max-h-64 space-y-1 overflow-y-auto" aria-busy={carregando && !diretorio}>
        {!diretorio && carregando ? <p className="px-1 py-2 text-xs text-muted-foreground">{t("Carregando…")}</p> : null}
        {pessoas.map((p) => {
          const livre = p.situacao === "disponivel";
          return (
            <div
              key={p.user_id}
              data-telefonia-pessoa={p.user_id}
              data-situacao={p.situacao}
              className={`flex items-center gap-2 rounded-md px-1.5 py-1 ${livre ? "" : "opacity-60"}`}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {p.nome}
                  {p.ramal ? <span className="ml-1 text-xs font-normal tabular-nums text-muted-foreground">{p.ramal}</span> : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">{t(ROTULO_DA_SITUACAO[p.situacao])}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={!livre || enviando}
                onClick={() => void pedir("consultada", { user_id: p.user_id })}
              >
                {t("Falar antes")}
              </Button>
              <Button size="sm" className="h-7 px-2 text-xs" disabled={!livre || enviando} onClick={() => void pedir("direta", { user_id: p.user_id })}>
                {t("Transferir")}
              </Button>
            </div>
          );
        })}
        {times.length > 0 ? <p className="px-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("Times")}</p> : null}
        {times.map((x) => {
          const aberto = x.situacao === "aberto";
          return (
            <div
              key={x.id}
              data-telefonia-time={x.id}
              className={`flex items-center gap-2 rounded-md px-1.5 py-1 ${aberto ? "" : "opacity-60"}`}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{x.nome}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {aberto
                    ? x.disponiveis === 1
                      ? t("1 disponível")
                      : t("{n} disponíveis").replace("{n}", String(x.disponiveis))
                    : t("Fora do horário")}
                </p>
              </div>
              <Button size="sm" className="h-7 px-2 text-xs" disabled={!aberto || enviando} onClick={() => void pedir("direta", { team_id: x.id })}>
                {t("Transferir")}
              </Button>
            </div>
          );
        })}
        {diretorio && pessoas.length === 0 && times.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">{t("Ninguém encontrado.")}</p>
        ) : null}
      </div>
    </div>
  );
}
