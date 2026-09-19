"use client";
/**
 * CHAMAR O CLIENTE — a conversa que começa do nosso lado.
 *
 * ─── O caminho que existia, e por que ele não servia ────────────────────────
 *
 * Dava para abrir uma conversa vazia a partir da lista de contatos: o ícone
 * navegava para o inbox e o operador escrevia lá. Funciona no canal de texto
 * livre. No canal oficial, não — e o modo de falhar era o pior possível:
 *
 *   1. o operador clica e vai para o inbox;
 *   2. a conversa abre vazia, sem nenhuma restrição à vista;
 *   3. **só então** aparece que a janela está fechada e que só sai modelo;
 *   4. ele escolhe um modelo e o envio falha, porque o modelo pede o nome dele
 *      e não havia onde digitar.
 *
 * A restrição aparecia depois da decisão, e a saída oferecida não existia. Aqui
 * ela aparece antes: escolhida a conexão, a tela já diz o que é possível
 * escrever, e o que precisa ser preenchido está na mesma janela.
 *
 * ─── Esta tela não sabe qual é o canal ──────────────────────────────────────
 *
 * Não há `if (provider === …)` aqui, e não pode haver — é o invariante 1 de
 * `docs/doctrine/restricao-de-canal.md`, que o `pnpm lint:channels` reprova. O
 * servidor responde `exige_modelo`, um fato sobre o que dá para escrever, e a
 * tela não faz ideia de quem impôs a regra. Canal novo não toca este arquivo.
 *
 * ─── Um ato, e uma rota ─────────────────────────────────────────────────────
 *
 * Abrir a conversa e mandar a primeira mensagem vão juntas em
 * `POST /conversations/iniciar`. Encadear duas chamadas daqui deixaria a
 * pergunta "e quando a segunda falha?" dentro de um componente de tela — e a
 * resposta (manter a conversa, mostrar o motivo real, deixar tentar de novo lá
 * dentro) é regra de produto, que a próxima tela precisa herdar.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { CamposDoModelo, aplicarValores, type CampoDoModelo } from "@/components/channels/CamposDoModelo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { lerConteudo } from "@/lib/channels/template-conteudo";
import { cn } from "@/lib/utils";

interface Conexao {
  id: string;
  display_name: string | null;
  phone_number: string | null;
  status: string;
}

interface ModeloDaConexao {
  name: string;
  language: string;
  status: string;
  category: string | null;
  components: unknown[];
  slots: CampoDoModelo[];
}

interface RespostaDeModelos {
  exige_modelo: boolean;
  modelos: ModeloDaConexao[];
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Quem vamos chamar. `contactId` ausente = contato ainda não cadastrado. */
  contactId?: string;
  /**
   * Opcional porque nem toda tela o tem em mãos: o dossiê de um negócio conhece
   * o `contact_id` e não o telefone. Serve só para MOSTRAR para quem se está
   * ligando — quem resolve o destino é o servidor, que lê o cadastro. Exigi-lo
   * aqui obrigaria cada chamador a buscar o contato só para abrir um diálogo.
   */
  phoneNumber?: string;
  nome: string;
}

const CLASSE_SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-hidden focus:ring-1 focus:ring-ring";

export function ChamarNoWhatsAppDialog({
  open,
  onOpenChange,
  contactId,
  phoneNumber,
  nome,
}: Props) {
  const t = useT();
  const router = useRouter();

  /**
   * Vazio = "ainda não escolhi", e a conexão efetiva é derivada da lista (ver
   * `conexaoId` abaixo). Guardar aqui a escolha PADRÃO exigiria um efeito que
   * escreve estado durante o render — que é o que dispara renders em cascata e
   * o que o lint reprova. Derivar não precisa de efeito nenhum.
   */
  const [conexaoEscolhida, setConexaoEscolhida] = useState("");
  const [escolhido, setEscolhido] = useState("");
  const [valores, setValores] = useState<Record<string, string>>({});
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);

  const { data: conexoes } = useQuery({
    queryKey: ["channel-sessions-para-chamar"],
    enabled: open,
    queryFn: async () =>
      (await apiClient.get<{ data: Conexao[] }>("/api/v1/channel-sessions")).data,
    staleTime: 30_000,
  });

  /**
   * A conexão que vale agora: a que o operador escolheu, ou a primeira viva.
   *
   * O padrão é `WORKING` antes de qualquer outra — mesma preferência de
   * `sessaoProntaParaEnvio` no servidor. Numa instalação com um número só, que
   * é a maioria, isso faz o seletor sumir e um clique deixar de existir.
   */
  const conexaoId = useMemo(() => {
    if (conexaoEscolhida) return conexaoEscolhida;
    if (!conexoes?.length) return "";
    return (conexoes.find((c) => c.status === "WORKING") ?? conexoes[0]!).id;
  }, [conexaoEscolhida, conexoes]);

  const {
    data: modelos,
    isLoading: carregandoModelos,
    isError: falhouAoPerguntar,
  } = useQuery({
    queryKey: ["modelos-para-chamar", conexaoId],
    enabled: open && !!conexaoId,
    queryFn: async () =>
      (
        await apiClient.get<{ data: RespostaDeModelos }>(
          `/api/v1/channels/modelos?channel_session_id=${conexaoId}`,
        )
      ).data,
    staleTime: 30_000,
  });

  /**
   * ⚠️ O default do desconhecido é `false`, e por isso ele NUNCA pode ser
   * usado sozinho.
   *
   * Se a pergunta "o que este canal permite?" falhar, `modelos` é `undefined`
   * e isto vira `false` — que se lê como "pode escrever à vontade". Num canal
   * oficial, seria a tela convidando o operador a redigir um texto livre que a
   * plataforma vai recusar: a mesma classe de afirmação falsa que este diálogo
   * existe para acabar, só que no outro sentido.
   *
   * Por isso todo ramo de render é guardado por `!falhouAoPerguntar`, e o erro
   * tem superfície própria. Não saber não é o mesmo que poder.
   */
  const exigeModelo = modelos?.exige_modelo ?? false;
  const disponiveis = useMemo(() => modelos?.modelos ?? [], [modelos]);
  const atual = disponiveis.find((m) => `${m.name}|${m.language}` === escolhido) ?? null;

  /**
   * Trocar de conexão zera modelo e valores: o modelo é aprovado POR CONTA, e
   * manter o anterior selecionado ofereceria um modelo que não existe na conta
   * nova — um clique que a plataforma recusa.
   *
   * No `onChange` e não num efeito: a troca é um EVENTO do operador, e é ele
   * que tem a informação. Um efeito sobre `conexaoId` faria o mesmo trabalho um
   * render depois, escrevendo estado durante a sincronização.
   */
  function trocarConexao(id: string) {
    setConexaoEscolhida(id);
    setEscolhido("");
    setValores({});
  }

  /** O corpo renderizado: é o que a conversa mostra e o que o cliente lê. */
  const corpoFinal = useMemo(() => {
    if (!exigeModelo) return texto.trim();
    if (!atual) return "";
    const conteudo = lerConteudo(atual.components);
    const bruto = conteudo.body?.trim() || atual.name;
    // Os valores do CORPO são os de chave sem prefixo — `slotKey` não prefixa o
    // body de propósito, "porque é o caso comum e casa com o `{{1}}` que o
    // operador vê" (`build-components.ts`). Cabeçalho e botões têm prefixo e
    // não entram no texto da bolha.
    const doCorpo: Record<string, string> = {};
    for (const slot of atual.slots) {
      if (slot.chave === slot.key) doCorpo[slot.key] = valores[slot.chave] ?? "";
    }
    return aplicarValores(bruto, doCorpo);
  }, [exigeModelo, texto, atual, valores]);

  const faltando = atual?.slots.filter((s) => !(valores[s.chave] ?? "").trim()) ?? [];
  const podeEnviar =
    !falhouAoPerguntar &&
    !carregandoModelos &&
    (exigeModelo
      ? !!atual && faltando.length === 0 && !!conexaoId
      : texto.trim().length > 0 && !!conexaoId);

  async function enviar() {
    if (!podeEnviar || enviando) return;
    setEnviando(true);
    try {
      const mensagem = exigeModelo
        ? {
            type: "template" as const,
            template_name: atual!.name,
            template_language: atual!.language,
            template_values: valores,
            // O corpo renderizado vai junto porque é o que a conversa grava e
            // mostra depois — o mesmo caminho que o agente já usa ao mandar
            // modelo. Sem ele o envio nem passa pelo schema.
            body: corpoFinal,
          }
        : { type: "text" as const, body: texto.trim() };

      const resposta = await apiClient.post<{
        data: {
          conversation_id: string;
          enviada: boolean;
          erro_envio: string | null;
        };
      }>("/api/v1/conversations/iniciar", {
        channel_session_id: conexaoId,
        contact_id: contactId,
        phone_number: phoneNumber,
        name: nome,
        mensagem,
      });

      const { conversation_id, enviada, erro_envio } = resposta.data;

      if (enviada) {
        toast.success(t("Mensagem enviada."));
      } else {
        // A conversa existe mesmo assim, e é para lá que o operador vai: o
        // seletor de modelos do inbox é onde ele tenta de novo. Segurar o
        // diálogo aberto o deixaria sem o caminho que acabou de ser criado.
        toast.error(erro_envio ?? t("A conversa abriu, mas a mensagem não saiu."));
      }
      onOpenChange(false);
      router.push(`/app/inbox?id=${conversation_id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Não consegui iniciar a conversa."));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Chamar no WhatsApp")}</DialogTitle>
          <DialogDescription>
            {t("Primeira mensagem para")} <strong>{nome}</strong>
            {phoneNumber ? ` (${phoneNumber})` : ""}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {(conexoes?.length ?? 0) > 1 && (
            <div className="space-y-1">
              <Label htmlFor="chamar-conexao" className="text-xs">
                {t("Enviar pelo número")}
              </Label>
              <select
                id="chamar-conexao"
                value={conexaoId}
                onChange={(e) => trocarConexao(e.target.value)}
                disabled={enviando}
                className={CLASSE_SELECT}
              >
                {conexoes!.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name ?? c.phone_number ?? c.id}
                    {c.status !== "WORKING" ? ` · ${c.status}` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          {conexoes?.length === 0 && (
            <p className="rounded-md border border-amber-300 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200">
              {t("Nenhum número de WhatsApp conectado. Conecte um em Conexões para poder chamar clientes.")}
            </p>
          )}

          {carregandoModelos && conexaoId && (
            <p className="text-xs text-text-muted">{t("Verificando o que este canal permite…")}</p>
          )}

          {falhouAoPerguntar && conexaoId && (
            // Sem saber o que o canal permite, oferecer QUALQUER campo é um
            // palpite — e o palpite errado manda texto livre por um canal que
            // só aceita modelo. Melhor não oferecer nada e dizer por quê.
            <p className="rounded-md border border-amber-300 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200">
              {t("Não consegui verificar o que este canal permite. Tente de novo em instantes.")}
            </p>
          )}

          {!carregandoModelos && !falhouAoPerguntar && conexaoId && !exigeModelo && (
            <div className="space-y-1">
              <Label htmlFor="chamar-texto" className="text-xs">
                {t("Mensagem")}
              </Label>
              <Textarea
                id="chamar-texto"
                rows={4}
                value={texto}
                disabled={enviando}
                onChange={(e) => setTexto(e.target.value)}
                placeholder={t("Escreva a primeira mensagem…")}
              />
            </div>
          )}

          {!carregandoModelos && !falhouAoPerguntar && conexaoId && exigeModelo && (
            <>
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-text-muted">
                {t("Este canal só permite falar primeiro com um modelo aprovado. Depois que o cliente responder, a conversa fica livre por 24 horas.")}
              </p>

              {disponiveis.length === 0 ? (
                <p className="text-xs text-amber-900 dark:text-amber-200">
                  {t("Nenhum modelo aprovado ainda. Crie um em")}{" "}
                  <strong>{t("Conexões → Templates")}</strong>{" "}
                  {t("e volte quando a plataforma aprovar.")}
                </p>
              ) : (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="chamar-modelo" className="text-xs">
                      {t("Modelo aprovado")}
                    </Label>
                    <select
                      id="chamar-modelo"
                      value={escolhido}
                      onChange={(e) => {
                        setEscolhido(e.target.value);
                        setValores({});
                      }}
                      disabled={enviando}
                      className={CLASSE_SELECT}
                    >
                      <option value="">{t("Escolha um modelo…")}</option>
                      {disponiveis.map((m) => (
                        <option key={`${m.name}|${m.language}`} value={`${m.name}|${m.language}`}>
                          {m.name} ({m.language})
                          {m.slots.length > 0 ? ` · ${m.slots.length} ${t("a preencher")}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>

                  {atual && (
                    <CamposDoModelo
                      campos={atual.slots}
                      valores={valores}
                      onChange={setValores}
                      disabled={enviando}
                    />
                  )}
                </>
              )}
            </>
          )}

          {corpoFinal && (
            <div className="space-y-1">
              <Label className="text-xs">{t("O cliente vai receber")}</Label>
              <p
                className={cn(
                  "whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 text-sm",
                  faltando.length > 0 && "text-text-muted",
                )}
              >
                {corpoFinal}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={enviando}
          >
            {t("Cancelar")}
          </Button>
          <Button type="button" onClick={() => void enviar()} disabled={!podeEnviar || enviando}>
            {enviando ? t("Enviando…") : t("Enviar e abrir conversa")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
