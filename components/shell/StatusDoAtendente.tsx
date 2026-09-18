"use client";
import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useStatusDoAtendente } from "@/hooks/atendimento/useStatusDoAtendente";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MOTIVOS_DE_PAUSA, rotuloDoMotivoDePausa, type MotivoDePausa } from "@/lib/atendimento/pausa";
import { ROLE_RANK } from "@/lib/auth/types";
import { formatarEspera } from "@/lib/inbox/espera";
import { CaretDown, Coffee } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * O STATUS DE ATENDIMENTO, na barra superior — online, em pausa ou offline.
 *
 * Mora na barra de cima, e não dentro do inbox, por duas razões: o rodízio
 * distribui conversa para quem está "online" esteja a pessoa na tela que
 * estiver, e o sinal de vida que mantém esse "online" de pé precisa rodar em
 * todas elas (ver `useStatusDoAtendente`).
 *
 * A PAUSA pede motivo. Não é burocracia: sem ele, banheiro, almoço e "fui
 * embora" têm a mesma cara, e quem gere a equipe não tem como saber onde o tempo
 * vai. Em pausa, a pessoa NÃO recebe conversa nova — a do time dela vai para o
 * colega, ou espera na fila. As que já são dela continuam dela.
 *
 * Só aparece para quem atende (`agent` para cima). `viewer` não entra no
 * rodízio, e um seletor de status seria um controle que não controla nada.
 */
const COR_DO_STATUS = {
  online: "bg-success",
  paused: "bg-warning",
  offline: "bg-border-strong",
} as const;

const ROTULO_DO_STATUS = {
  online: "Online",
  paused: "Em pausa",
  offline: "Offline",
} as const;

export function StatusDoAtendente() {
  const t = useT();
  const { activeOrg, user } = useAuth();
  const atende =
    activeOrg != null &&
    ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent &&
    user.support?.access_mode !== "support_readonly";
  const { data, mudar, isError } = useStatusDoAtendente(atende);

  const [dialogoAberto, setDialogoAberto] = useState(false);
  const [motivo, setMotivo] = useState<MotivoDePausa | null>(null);
  const [observacao, setObservacao] = useState("");

  // O tempo de pausa anda sozinho: o atendente olha para cá para saber há
  // quanto tempo saiu, e um número parado mentiria a cada minuto.
  const [agora, setAgora] = useState(() => Date.now());
  const emPausa = data?.status === "paused";
  useEffect(() => {
    if (!emPausa) return;
    const id = setInterval(() => setAgora(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [emPausa]);

  if (!atende) return null;

  const status = data?.status ?? "offline";
  const haQuanto =
    emPausa && data?.paused_at ? formatarEspera(Math.max(0, agora - new Date(data.paused_at).getTime()), t) : null;

  const confirmarPausa = () => {
    if (!motivo) return;
    if (motivo === "outro" && observacao.trim() === "") return;
    mudar.mutate(
      { status: "paused", reason: motivo, note: observacao.trim() || undefined },
      {
        onSuccess: () => {
          setDialogoAberto(false);
          setMotivo(null);
          setObservacao("");
        },
      },
    );
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 rounded-full px-2.5 text-xs font-medium"
            data-testid="status-do-atendente"
            data-status={status}
            aria-label={`${t("Seu status de atendimento")}: ${t(ROTULO_DO_STATUS[status])}`}
          >
            <span className={cn("h-2 w-2 shrink-0 rounded-full", COR_DO_STATUS[status])} aria-hidden />
            <span className="hidden sm:inline">
              {emPausa
                ? `${t("Em pausa")} · ${t(rotuloDoMotivoDePausa(data?.pause_reason))}${haQuanto ? ` · ${haQuanto}` : ""}`
                : t(ROTULO_DO_STATUS[status])}
            </span>
            <CaretDown size={12} aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[260px]">
          <DropdownMenuLabel className="space-y-0.5">
            <div className="text-sm font-medium">{t("Seu status de atendimento")}</div>
            <p className="text-xs font-normal text-muted-foreground">
              {status === "online"
                ? t("Você recebe conversas novas do rodízio.")
                : status === "paused"
                  ? t("Em pausa você não recebe conversas novas. As que já são suas continuam com você.")
                  : t("Offline você não recebe conversas novas do rodízio.")}
            </p>
            {isError && <p className="text-xs font-normal text-error-fg">{t("Não consegui ler o seu status.")}</p>}
            {typeof data?.current_load === "number" && (
              <p className="text-xs font-normal text-muted-foreground" data-testid="carga-do-atendente">
                {t("Conversas com você agora")}: {data.current_load}
                {typeof data.capacity === "number" ? ` / ${data.capacity}` : ""}
              </p>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={mudar.isPending || status === "online"}
            data-testid="status-ficar-online"
            onClick={() => mudar.mutate({ status: "online" })}
          >
            <span className={cn("mr-2 h-2 w-2 rounded-full", COR_DO_STATUS.online)} aria-hidden />
            {emPausa ? t("Voltar da pausa") : t("Ficar online")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={mudar.isPending}
            data-testid="status-pausar"
            onClick={() => setDialogoAberto(true)}
          >
            <Coffee size={14} className="mr-2" aria-hidden />
            {emPausa ? t("Trocar o motivo da pausa…") : t("Entrar em pausa…")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={mudar.isPending || status === "offline"}
            data-testid="status-ficar-offline"
            onClick={() => mudar.mutate({ status: "offline" })}
          >
            <span className={cn("mr-2 h-2 w-2 rounded-full", COR_DO_STATUS.offline)} aria-hidden />
            {t("Ficar offline")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialogoAberto} onOpenChange={setDialogoAberto}>
        <DialogContent data-testid="dialogo-de-pausa">
          <DialogHeader>
            <DialogTitle>{t("Entrar em pausa")}</DialogTitle>
            <DialogDescription>
              {t("Enquanto você estiver em pausa, as conversas novas do seu time vão para outro colega ou esperam na fila. Escolha o motivo — ele fica registrado.")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("Motivo da pausa")}>
            {MOTIVOS_DE_PAUSA.map((m) => (
              <button
                key={m.valor}
                type="button"
                role="radio"
                aria-checked={motivo === m.valor}
                data-testid={`motivo-${m.valor}`}
                onClick={() => setMotivo(m.valor)}
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-sm transition-colors",
                  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                  motivo === m.valor ? "border-accent bg-accent-soft text-accent" : "border-border hover:bg-surface-elevated",
                )}
              >
                {t(m.rotulo)}
              </button>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="observacao-da-pausa">
              {motivo === "outro" ? t("Qual o motivo?") : t("Observação (opcional)")}
            </Label>
            <Textarea
              id="observacao-da-pausa"
              value={observacao}
              maxLength={200}
              rows={2}
              onChange={(e) => setObservacao(e.target.value)}
              placeholder={t("Ex.: volto às 13h")}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogoAberto(false)}>
              {t("Cancelar")}
            </Button>
            <Button
              data-testid="confirmar-pausa"
              disabled={mudar.isPending || !motivo || (motivo === "outro" && observacao.trim() === "")}
              onClick={confirmarPausa}
            >
              {mudar.isPending ? t("Pausando...") : t("Entrar em pausa")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
