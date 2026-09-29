"use client";
/**
 * A faixa do aviso de instabilidade do telefone, em TODA tela do CRM (desenho da
 * fase 2, §6.4): todo membro vê que os clientes estão ouvindo um aviso — o
 * atendente que atende o telefone precisa saber o que o cliente acabou de ouvir.
 * Gerente e admin (`pode_mudar`, decidido pelo servidor) desligam por aqui mesmo.
 * Aparece e some sem recarregar a página (`useAvisosNaFaixa`, que pede à rota só
 * a faixa — `?so=ligados` —, nunca a lista completa do gerente).
 *
 * `oferecida` vem do LAYOUT (servidor), que sabe se a instalação tem telefonia
 * sem perguntar a ninguém: sem ela, a faixa não faz uma leitura sequer — a
 * consulta de 60 s só existe onde há ligação para ouvir aviso.
 *
 * Não é `sticky` por conta própria: quem gruda no topo é o contêiner do layout
 * que a empilha com a faixa de conexão caída (`data-faixas-do-topo`).
 *
 * A leitura que falha some com a faixa, em silêncio: uma falha não pode derrubar
 * o layout (a faixa roda em toda tela), nem deixar à vista um aviso que já não dá
 * para confirmar — o prazo pode ter passado enquanto a API não respondia.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { Siren } from "@/lib/ui/icons";

import { horaDoAviso, useAvisosNaFaixa, useDesligarAviso } from "./useAvisosDeInstabilidade";

export function FaixaDoAvisoDeInstabilidade({ oferecida }: { oferecida: boolean }) {
  const t = useT();
  const locale = useLocaleDeData();
  const avisos = useAvisosNaFaixa(oferecida);
  const desligar = useDesligarAviso();

  const dados = avisos.data;
  if (!oferecida || avisos.isError || !dados?.oferecida || dados.ligados.length === 0) return null;
  const agora = new Date();

  return (
    <div
      role="status"
      aria-live="polite"
      data-faixa-aviso-de-instabilidade=""
      className="flex flex-col gap-1 border-b border-amber-300 bg-amber-100/95 px-4 py-2 text-sm text-amber-950 backdrop-blur dark:border-amber-700/60 dark:bg-amber-950/70 dark:text-amber-50"
    >
      {dados.ligados.map((a) => {
        const desligando = desligar.isPending && desligar.variables === a.team_id;
        return (
          <div key={a.team_id} data-aviso-na-faixa={a.team_id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex flex-wrap items-center gap-2">
              <Siren size={16} aria-hidden />
              <span>
                {t("Aviso de instabilidade ligado no telefone do")} <strong className="font-semibold">{a.time_nome}</strong>
              </span>
              {a.arquivado ? (
                <Badge variant="outline" data-time-arquivado="" className="border-amber-500/60">
                  {t("Time arquivado")}
                </Badge>
              ) : null}
              <span>
                {"· "}
                {a.expira_em ? `${t("desliga às")} ${horaDoAviso(a.expira_em, agora, locale)}` : t("até alguém desligar")}
              </span>
            </span>
            {dados.pode_mudar ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={desligando ? undefined : t("Desligar o aviso do time {time}").replace("{time}", a.time_nome)}
                onClick={() => desligar.mutate(a.team_id)}
                disabled={desligar.isPending}
              >
                {desligando ? t("Desligando…") : t("Desligar")}
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
