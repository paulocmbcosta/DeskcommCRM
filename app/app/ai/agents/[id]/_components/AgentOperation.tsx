"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { AgentRow } from "@/hooks/ai/useAgent";

/** O padrão do worker de sentimento — o mesmo de `sentimento-do-turno.ts`. */
const LIMITE_PADRAO = 0.3;

function limiteAtual(agent: AgentRow): number {
  const v = (agent.config ?? {})["sentiment_threshold"];
  return typeof v === "number" ? v : LIMITE_PADRAO;
}

export function AgentOperation({ agent, readOnly }: { agent: AgentRow; readOnly?: boolean }) {
  const t = useT(),
    router = useRouter(),
    [busy, setBusy] = useState(false),
    [limite, setLimite] = useState(() => limiteAtual(agent).toFixed(2));
  async function change(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await apiClient.patch(`/api/v1/ai/agents/${agent.id}`, body);
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setBusy(false);
    }
  }
  // O LIMITE DE INSATISFAÇÃO. Mora aqui, e não no formulário da versão, porque é
  // do AGENTE (`ai_agents.config`), não de uma versão: vale na hora, sem publicar.
  // Antes desta tela ele só era ajustável por SQL.
  const numero = Number(limite.replace(",", "."));
  const limiteValido = !Number.isNaN(numero) && numero >= 0 && numero <= 1;
  const limiteMudou = limiteValido && Math.abs(numero - limiteAtual(agent)) > 0.0001;
  return (
    <section
      className="flex flex-wrap items-center gap-3 rounded-md border p-3"
      aria-label={t("Operação do agente")}
    >
      <label className="text-sm">
        {t("Operação do agente")}{" "}
        <select
          className="ml-2 rounded-md border bg-background p-2"
          aria-label={t("Modo de operação")}
          value={agent.operation_mode ?? "automatic"}
          disabled={readOnly || busy}
          onChange={(e) => change({ operation_mode: e.target.value })}
        >
          <option value="assisted">{t("Assistido: revisar antes de enviar")}</option>
          <option value="automatic">{t("Automático: responder com as regras do agente")}</option>
        </select>
      </label>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={readOnly || busy || !agent.published_version_id}
        onClick={() => change({ paused_at: agent.paused_at ? null : new Date().toISOString() })}
      >
        {t(agent.paused_at ? "Retomar automático" : "Pausar automático")}
      </Button>
      <p className="w-full text-xs text-muted-foreground">
        {t(
          agent.paused_at
            ? "Automático pausado. A versão publicada foi preservada e a assistência continua disponível."
            : "O modo assistido prepara sugestões na conversa. Só a aprovação humana autoriza o envio.",
        )}
      </p>
      <div className="flex w-full flex-wrap items-center gap-2 border-t pt-3" data-testid="limite-de-insatisfacao">
        <label htmlFor={`limite-${agent.id}`} className="text-sm">
          {t("Cliente muito insatisfeito abaixo da nota")}
        </label>
        <Input
          id={`limite-${agent.id}`}
          inputMode="decimal"
          className="w-20"
          value={limite}
          disabled={readOnly || busy}
          onChange={(e) => setLimite(e.target.value)}
          aria-invalid={!limiteValido}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={readOnly || busy || !limiteMudou}
          onClick={() => change({ config: { sentiment_threshold: Math.round(numero * 100) / 100 } })}
        >
          {t("Salvar limite")}
        </Button>
        <p className="w-full text-xs text-muted-foreground">
          {t(
            "De 0 a 1. Abaixo desta nota o momento entra na linha do tempo da conversa e o agente acolhe o cliente e passa para o setor responsável. Mais baixo = só os casos mais graves. Padrão 0,30.",
          )}
        </p>
      </div>
    </section>
  );
}
