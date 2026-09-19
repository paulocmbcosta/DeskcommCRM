"use client";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";

import { CamposDoModelo, aplicarValores, type CampoDoModelo } from "@/components/channels/CamposDoModelo";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { apiClient } from "@/lib/api/client";
import { lerConteudo } from "@/lib/channels/template-conteudo";
import { cn } from "@/lib/utils";

/**
 * A janela fechou — e aqui está o caminho de volta, INTEIRO.
 *
 * ─── Por que barrar sem oferecer saída não serve ────────────────────────────
 *
 * O texto livre fora das 24h é barrado, que é o certo. Mas barrar sem oferecer
 * o modelo deixa o operador SEM caminho: ele lê "só modelo aprovado sai daqui"
 * e não tem como mandar um.
 *
 * ─── A saída que era oferecida NÃO EXISTIA ──────────────────────────────────
 *
 * A primeira versão desta tela resolveu metade: listou os modelos aprovados e
 * marcou quais pediam parâmetro. Só que ela não coletava valor nenhum, enviava
 * com `values: {}`, e o próprio comentário admitia que "a plataforma recusa".
 * Para esses, ela mandava o operador para **Conexões → Templates**.
 *
 * Medido em 2026-09-19: `components/connections/TemplatesClient.tsx` não tem
 * envio. Nem botão, nem `POST`, nem a palavra "enviar" — é uma tela de
 * listagem e preview. A saída oferecida era um beco sem saída, e a frase que a
 * oferecia era uma afirmação de estado falsa dentro do produto.
 *
 * Como todo modelo de reabertura carrega ao menos o nome de quem se está
 * chamando, o caminho de volta simplesmente não fechava. Agora fecha: os
 * campos são derivados do contrato e ficam aqui mesmo (`CamposDoModelo`).
 *
 * ─── Por que a lista vem por CONEXÃO, e não por provider ────────────────────
 *
 * Esta tela pedia as definições pela rota do provider (`fonteDeTemplates`), e
 * isso trazia dois defeitos herdados: no canal oficial a rota exige `admin`, e
 * um `agent` — quem atende — recebia 403 e lia "Nenhum modelo aprovado ainda",
 * que é falso; no canal intermediado a rota não devolve `slots`, então o aviso
 * de parâmetros nunca aparecia.
 *
 * `GET /channels/modelos?channel_session_id=…` resolve as duas coisas no
 * servidor e responde igual para qualquer canal. A tela continua sem saber
 * quem é o provider.
 */
interface ModeloDaConexao {
  name: string;
  language: string;
  components: unknown[];
  slots: CampoDoModelo[];
}

/**
 * O texto da definição aprovada, que vai no `body` do envio.
 *
 * Cai para o nome do modelo quando a definição não trouxer corpo: um `body`
 * vazio reprovaria no schema de envio e a conversa mostraria uma bolha em
 * branco. Só acontece em definição sem BODY, que a plataforma não aprova.
 */
function textoDoModelo(modelo: ModeloDaConexao): string {
  return lerConteudo(modelo.components).body?.trim() || modelo.name;
}

export function JanelaFechadaAviso({
  conversationId,
  channelSessionId,
  motivo,
}: {
  conversationId: string;
  /** A conexão desta conversa. Decide QUAIS definições existem. */
  channelSessionId: string | null;
  motivo: string;
}) {
  const t = useT();
  const send = useSendMessage();
  const [escolhido, setEscolhido] = useState("");
  const [valores, setValores] = useState<Record<string, string>>({});

  const { data, isError: falhouAoPerguntar } = useQuery({
    // A chave inclui a conexão: sem isso, trocar de conversa entre canais
    // serviria a lista em cache do anterior, e o operador mandaria um modelo
    // que não existe na conta desta conversa.
    queryKey: ["modelos-da-conversa", channelSessionId],
    enabled: !!channelSessionId,
    queryFn: async () =>
      (
        await apiClient.get<{ data: { exige_modelo: boolean; modelos: ModeloDaConexao[] } }>(
          `/api/v1/channels/modelos?channel_session_id=${channelSessionId}`,
        )
      ).data,
    staleTime: 30_000,
  });

  // A rota já devolve só os aprovados: oferecer um `PENDING` seria oferecer um
  // clique que falha, e quem acompanha revisão tem a tela de Conexões.
  const aprovados = useMemo(() => data?.modelos ?? [], [data]);
  const atual = aprovados.find((tpl) => `${tpl.name}|${tpl.language}` === escolhido) ?? null;
  const faltando = atual?.slots.filter((s) => !(valores[s.chave] ?? "").trim()) ?? [];

  /** O que o cliente vai ler — os valores do corpo aplicados sobre o texto. */
  const corpoFinal = useMemo(() => {
    if (!atual) return "";
    const doCorpo: Record<string, string> = {};
    // Chave sem prefixo = slot do corpo (`slotKey` não prefixa o body). Header
    // e botões têm prefixo e não entram no texto da bolha.
    for (const slot of atual.slots) {
      if (slot.chave === slot.key) doCorpo[slot.key] = valores[slot.chave] ?? "";
    }
    return aplicarValores(textoDoModelo(atual), doCorpo);
  }, [atual, valores]);

  function enviar() {
    if (!atual || faltando.length > 0) return;
    send.mutate(
      {
        conversation_id: conversationId,
        type: "template",
        template_name: atual.name,
        template_language: atual.language,
        // Os valores que a plataforma exige. Enviar sem eles era a recusa
        // garantida que esta tela existia para evitar e provocava.
        template_values: valores,
        // O `body` NÃO é decorativo: `sendMessageSchema` exige body, media_url
        // ou media_storage_path, e sem ele o pedido morre em 422 ANTES de tocar
        // o transporte. É também o texto que a conversa mostra depois.
        body: corpoFinal,
      },
      {
        onSuccess: () => {
          setEscolhido("");
          setValores({});
          toast.success(t("Modelo enviado — a janela reabre quando o cliente responder."));
        },
        onError: (e: unknown) =>
          toast.error(e instanceof Error ? e.message : t("Não consegui enviar o modelo.")),
      },
    );
  }

  return (
    <div className="border-t border-amber-300 bg-amber-50/60 px-4 py-3 dark:border-amber-800/60 dark:bg-amber-950/30">
      <p className="mb-2 text-xs text-amber-900 dark:text-amber-200">{motivo}</p>

      {falhouAoPerguntar ? (
        // "Nenhum modelo aprovado" e "não consegui perguntar" levam a ações
        // opostas — criar um modelo, ou tentar de novo. Colapsar as duas manda
        // o operador criar um modelo que provavelmente já existe, que é a
        // mesma afirmação falsa que este aviso passou a consertar.
        <p className="text-xs text-amber-900/80 dark:text-amber-200/80">
          {t("Não consegui carregar os modelos deste canal. Tente de novo em instantes.")}
        </p>
      ) : aprovados.length === 0 ? (
        // Sem modelo aprovado não há saída por aqui, e dizer isso é melhor que
        // um seletor vazio que se lê como "ainda não carregou".
        <p className="text-xs text-amber-900/80 dark:text-amber-200/80">
          {t("Nenhum modelo aprovado ainda. Crie um em")} <strong>{t("Conexões → Templates")}</strong>{" "}
          {t("e envie quando a plataforma aprovar.")}
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={escolhido}
              onChange={(e) => {
                setEscolhido(e.target.value);
                setValores({});
              }}
              disabled={send.isPending}
              aria-label={t("Modelo aprovado")}
              className={cn(
                "h-9 min-w-[16rem] flex-1 rounded-md border border-input bg-background px-2 text-sm",
                "focus:outline-hidden focus:ring-1 focus:ring-ring",
              )}
            >
              <option value="">{t("Escolha um modelo aprovado…")}</option>
              {aprovados.map((tpl) => (
                <option key={`${tpl.name}|${tpl.language}`} value={`${tpl.name}|${tpl.language}`}>
                  {tpl.name} ({tpl.language})
                  {tpl.slots.length > 0 ? ` · ${tpl.slots.length} ${t("a preencher")}` : ""}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              onClick={enviar}
              disabled={!atual || faltando.length > 0 || send.isPending}
            >
              {send.isPending ? t("Enviando…") : t("Enviar modelo")}
            </Button>
          </div>

          {atual && atual.slots.length > 0 && (
            <CamposDoModelo
              campos={atual.slots}
              valores={valores}
              onChange={setValores}
              disabled={send.isPending}
            />
          )}

          {corpoFinal && (
            <p className="whitespace-pre-wrap rounded-md border border-amber-300/60 bg-background/60 px-2 py-1.5 text-xs dark:border-amber-800/40">
              {corpoFinal}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
