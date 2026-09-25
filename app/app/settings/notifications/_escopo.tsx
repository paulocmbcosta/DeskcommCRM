"use client";
/**
 * DE QUAIS CONVERSAS CHEGA O AVISO DE MENSAGEM — a escolha de cada pessoa
 * (migration 0281). Vale para o push do servidor e para o aviso com a aba
 * aberta; os interruptores da tabela abaixo decidem POR ONDE, e esta escolha
 * decide DE QUÊ.
 *
 * O padrão do atendente é "só as minhas": a conversa que ele apenas enxerga
 * (a fila do time, a do colega) não é motivo para tocar o celular dele.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  ESCOPOS_DE_AVISO,
  escolhaDaSessaoAtual,
  escopoEfetivo,
  lembrarEscolhaDaSessao,
  type EscopoDeAviso,
} from "@/lib/notifications/escopo-de-aviso";

const COPY: Record<EscopoDeAviso, { titulo: string; corpo: string }> = {
  mine: {
    titulo: "Só das conversas que são minhas",
    corpo: "Você é avisado quando o cliente escreve numa conversa atribuída a você.",
  },
  all_visible: {
    titulo: "De todas as conversas que eu vejo",
    corpo:
      "Inclui a fila e as conversas dos colegas que você enxerga. Útil para quem distribui o atendimento; barulhento para quem atende.",
  },
};

export function EscopoDoAvisoDeMensagem() {
  const t = useT();
  const org = useActiveOrg();
  const atual: EscopoDeAviso =
    escolhaDaSessaoAtual() ??
    (org ? (org.aviso_de_mensagem ?? escopoEfetivo(org.role, null)) : "mine");
  const [escolhido, setEscolhido] = useState<EscopoDeAviso>(atual);
  const [isPending, startTransition] = useTransition();

  function escolher(escopo: EscopoDeAviso) {
    const antes = escolhido;
    setEscolhido(escopo);
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/notifications/escopo", { escopo });
        // O aviso com a aba aberta passa a valer já, sem recarregar a página.
        lembrarEscolhaDaSessao(escopo);
        toast.success(t("Preferência de aviso salva."));
      } catch (err) {
        setEscolhido(antes);
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }

  return (
    <Card className="space-y-3 p-4" data-testid="escopo-aviso-mensagem">
      <div>
        <h2 className="text-sm font-semibold">{t("Avisar de mensagem nova")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("Vale para o aviso na tela e para o push. Só você muda esta escolha.")}
        </p>
      </div>
      <div className="space-y-2">
        {ESCOPOS_DE_AVISO.map((v) => {
          const marcado = escolhido === v;
          return (
            <label
              key={v}
              data-testid={`opcao-aviso-${v}`}
              data-marcada={marcado ? "sim" : "nao"}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                marcado ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
              }`}
            >
              <input
                type="radio"
                name="escopo-aviso"
                value={v}
                checked={marcado}
                disabled={isPending}
                onChange={() => escolher(v)}
                className="mt-1 h-4 w-4 shrink-0 accent-primary"
                aria-label={t(COPY[v].titulo)}
              />
              <span className="space-y-1">
                <span className="block text-sm font-medium">{t(COPY[v].titulo)}</span>
                <span className="block text-xs text-muted-foreground">{t(COPY[v].corpo)}</span>
              </span>
            </label>
          );
        })}
      </div>
    </Card>
  );
}
