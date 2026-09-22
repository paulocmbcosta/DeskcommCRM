"use client";

/**
 * "QUANDO O CARD NASCE" — a superfície da regra `settings.crm.nascimento_do_card`.
 *
 * Mora na tela de funis porque é dela a pergunta "por que este card está aqui?".
 * Quem não é admin VÊ a regra em vigor (saber por que um card não nasceu é
 * direito de quem opera), mas só o admin a muda — a action confere de novo.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { definirNascimentoDoCard, type ErroNascimentoDoCard } from "@/app/actions/settings/definirNascimentoDoCard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import {
  LIMIARES_DO_CLASSIFICADOR,
  type ModoDeNascimentoDoCard,
  type NascimentoDoCard as Regra,
} from "@/lib/schemas/settings";

const MENSAGEM_DO_ERRO: Record<ErroNascimentoDoCard, string> = {
  invalido: "Escolha um modo e uma certeza mínima válidos.",
  sessao: "Sua sessão expirou. Entre de novo.",
  somente_leitura: "Acompanhamento somente leitura ou encerrado.",
  sem_empresa: "Nenhuma empresa ativa.",
  sem_permissao: "Só um administrador pode mudar essa regra.",
  sem_chave_openrouter: "Cadastre uma chave da OpenRouter em IA › Provedores antes de ligar esta regra.",
  falha: "Não consegui salvar essa mudança agora.",
};

export function NascimentoDoCard({ inicial, podeEditar }: { inicial: Regra; podeEditar: boolean }) {
  const t = useT();
  const [modo, setModo] = useState<ModoDeNascimentoDoCard>(inicial.modo);
  const [limiar, setLimiar] = useState<number>(inicial.limiar);
  const [salvando, iniciar] = useTransition();
  const mudou = modo !== inicial.modo || limiar !== inicial.limiar;
  const bloqueado = !podeEditar || salvando;

  function salvar() {
    iniciar(async () => {
      const r = await definirNascimentoDoCard({ modo, limiar });
      if (r.ok) toast.success(t("Regra salva."));
      else toast.error(t(MENSAGEM_DO_ERRO[r.erro]));
    });
  }

  return (
    <Card className="space-y-4 p-4" data-testid="nascimento-do-card">
      <div>
        <h2 className="text-base font-semibold">{t("Quando o card nasce")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Decide quais conversas abrem um card no funil de entrada.")}
        </p>
      </div>

      <fieldset className="space-y-3">
        <legend className="sr-only">{t("Quando o card nasce")}</legend>
        <div className="flex items-start gap-2">
          <input
            id="nascimento-toda-conversa"
            type="radio"
            name="modo-nascimento"
            className="mt-1"
            checked={modo === "toda_conversa"}
            disabled={bloqueado}
            onChange={() => setModo("toda_conversa")}
          />
          <Label htmlFor="nascimento-toda-conversa" className="font-normal leading-snug">
            <strong>{t("Toda conversa vira card")}</strong>
            <span className="block text-muted-foreground">
              {t("A primeira mensagem de quem não tem card abre um no funil de entrada.")}
            </span>
          </Label>
        </div>
        <div className="flex items-start gap-2">
          <input
            id="nascimento-classificador"
            type="radio"
            name="modo-nascimento"
            className="mt-1"
            checked={modo === "classificador"}
            disabled={bloqueado}
            onChange={() => setModo("classificador")}
          />
          <Label htmlFor="nascimento-classificador" className="font-normal leading-snug">
            <strong>{t("Só conversas comerciais")}</strong>
            <span className="block text-muted-foreground">
              {t(
                "A cada mensagem de quem ainda não tem card, a IA decide se o assunto é contratação, mudança de plano ou conhecer planos. Suporte, financeiro e cancelamento não abrem card.",
              )}
            </span>
          </Label>
        </div>
      </fieldset>

      {modo === "classificador" ? (
        <div className="space-y-1">
          <Label htmlFor="limiar-classificador">{t("Certeza mínima para abrir o card")}</Label>
          <Select value={String(limiar)} onValueChange={(v) => setLimiar(Number(v))} disabled={bloqueado}>
            <SelectTrigger id="limiar-classificador" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMIARES_DO_CLASSIFICADOR.map((l) => (
                <SelectItem key={l} value={String(l)}>
                  {Math.round(l * 100)}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t(
              "Mais alto abre menos cards por engano, mas pode deixar passar uma venda. Se a IA não conseguir responder, o card nasce assim mesmo e a linha do tempo diz por quê.",
            )}
          </p>
        </div>
      ) : null}

      {podeEditar ? (
        <Button onClick={salvar} disabled={!mudou || salvando}>
          {salvando ? t("Salvando…") : t("Salvar")}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">{t("Só um administrador pode mudar essa regra.")}</p>
      )}
    </Card>
  );
}
