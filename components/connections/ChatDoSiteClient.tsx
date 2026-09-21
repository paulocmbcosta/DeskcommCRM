"use client";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { ChatCircle, PaperPlaneTilt, Trash, X } from "@/lib/ui/icons";
import { apiClient } from "@/lib/api/client";
import { melhorFrenteSobre } from "@/lib/branding/contraste";
import { ehHexValido } from "@/lib/branding/rampa";
import {
  IDIOMAS_DO_WIDGET,
  MODOS_DO_CAMPO,
  POSICOES_DO_WIDGET,
  type ConfigDoWidget,
  type ModoDoCampo,
} from "@/lib/channels/chat-do-site/config";
import { copyToClipboard } from "@/lib/clipboard";

import { ChannelAiAccess } from "./ChannelAiAccess";

/**
 * Chat do site — o widget que o dono cola no próprio site.
 *
 * ─── A ordem da tela é a ordem em que dá errado ─────────────────────────────
 *
 * 1. Criar (um nome, um clique) — o widget nasce com aparência padrão que JÁ
 *    funciona, para que o código de instalação exista antes de qualquer ajuste.
 * 2. Personalizar, com a prévia ao lado. A prévia é o motivo da tela: cor
 *    escolhida num campo de texto e conferida só no site do cliente é uma volta
 *    de cinco minutos por tentativa.
 * 3. Instalar — o código pronto para copiar e, logo abaixo, o SINAL: "visto em
 *    exemplo.com há 2 min" ou "ainda não detectamos". É o que separa "criei" de
 *    "está no ar", e sem ele o defeito mais comum (colar no lugar errado) só
 *    apareceria como "ninguém escreve".
 *
 * O código de instalação vem PRONTO do servidor: montado aqui, ele usaria o
 * endereço embutido no build, que na imagem genérica do self-host é um
 * placeholder (ver `lib/channels/chat-do-site/snippet.ts`).
 */

interface CanalDaTela {
  id: string;
  nome: string;
  widget_key: string;
  config: ConfigDoWidget;
  snippet: string;
  created_at: string;
  last_seen: { at: string; site: string | null } | null;
}

interface Resposta {
  canais: CanalDaTela[];
  config_padrao: ConfigDoWidget;
}

const CHAVE_DA_CONSULTA = ["channels-site-chat"] as const;

function mensagemDeErro(err: unknown, padrao: string, t: (s: string) => string): string {
  return err instanceof Error && err.message ? t(err.message) : t(padrao);
}

export function ChatDoSiteClient() {
  const t = useT();
  const qc = useQueryClient();
  const consulta = useQuery({
    queryKey: CHAVE_DA_CONSULTA,
    queryFn: () => apiClient.get<{ data: Resposta }>("/api/v1/channels/site-chat"),
    // O sinal de instalação muda sem ninguém clicar em nada nesta tela: o dono
    // cola o código noutra aba e volta para cá esperando ver "instalado".
    refetchInterval: 20_000,
  });
  const [nomeNovo, setNomeNovo] = useState("");
  const [criando, setCriando] = useState(false);

  const canais = consulta.data?.data.canais ?? [];

  const criar = async () => {
    setCriando(true);
    try {
      await apiClient.post("/api/v1/channels/site-chat", { nome: nomeNovo.trim() || t("Chat do site") });
      setNomeNovo("");
      toast.success(t("Chat do site criado. Agora é só colar o código no seu site."));
      await qc.invalidateQueries({ queryKey: CHAVE_DA_CONSULTA });
      // O canal novo entra no filtro do inbox e nos seletores de agente.
      await qc.invalidateQueries({ queryKey: ["channel-sessions"] });
    } catch (err) {
      toast.error(mensagemDeErro(err, "Não foi possível criar o chat do site.", t));
    } finally {
      setCriando(false);
    }
  };

  if (consulta.isLoading) {
    return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  }

  if (consulta.isError) {
    // Erro tem que aparecer como erro: uma lista vazia aqui convidaria o dono a
    // criar um segundo widget por cima de um que já está colado no site.
    return (
      <Card className="flex flex-col items-start gap-3 p-4" role="alert">
        <p className="text-sm text-error-fg">{t("Não foi possível carregar o chat do site.")}</p>
        <Button variant="outline" size="sm" onClick={() => void consulta.refetch()}>
          {t("Tentar novamente")}
        </Button>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {canais.map((canal) => (
        <EditorDoCanal key={canal.id} canal={canal} />
      ))}

      <Card className="flex flex-col gap-3 p-4">
        <div>
          <h3 className="text-sm font-semibold">
            {canais.length === 0 ? t("Coloque um chat no seu site") : t("Criar outro chat do site")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {canais.length === 0
              ? t(
                  "Um balão de conversa aparece no canto do seu site. Quem escrever ali cai no Inbox como uma conversa nova — com lead, atendente e agente de IA, igual ao WhatsApp.",
                )
              : t("Use um chat por site quando quiser cores, textos ou atendimento diferentes em cada um.")}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="site-chat-nome-novo">{t("Nome do chat (só você vê)")}</Label>
            <Input
              id="site-chat-nome-novo"
              value={nomeNovo}
              maxLength={60}
              onChange={(e) => setNomeNovo(e.target.value)}
              placeholder={t("Ex.: Site da loja")}
            />
          </div>
          <Button onClick={criar} disabled={criando} data-testid="site-chat-criar">
            {criando ? t("Criando…") : t("Criar chat do site")}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function iguais(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function EditorDoCanal({ canal }: { canal: CanalDaTela }) {
  const t = useT();
  const qc = useQueryClient();
  const [nome, setNome] = useState(canal.nome);
  const [config, setConfig] = useState<ConfigDoWidget>(canal.config);
  const [dominios, setDominios] = useState(canal.config.dominios_permitidos.join("\n"));
  const [salvando, setSalvando] = useState(false);
  const [excluir, setExcluir] = useState(false);
  const [excluindo, setExcluindo] = useState(false);

  // O servidor é a verdade depois de salvar; enquanto há edição local, não se
  // pisa nela com o que o refetch de 20s trouxe.
  const [sujo, setSujo] = useState(false);
  useEffect(() => {
    if (sujo) return;
    setNome(canal.nome);
    setConfig(canal.config);
    setDominios(canal.config.dominios_permitidos.join("\n"));
  }, [canal, sujo]);

  const listaDeDominios = useMemo(
    () =>
      dominios
        .split(/[\n,]+/)
        .map((d) =>
          d
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .replace(/\/.*$/, ""),
        )
        .filter((d) => d.length > 0),
    [dominios],
  );

  const proposta: ConfigDoWidget = useMemo(
    () => ({ ...config, dominios_permitidos: listaDeDominios }),
    [config, listaDeDominios],
  );
  const mudou = nome.trim() !== canal.nome || !iguais(proposta, canal.config);
  const corValida = ehHexValido(config.cor_principal);

  const mudar = (patch: Partial<ConfigDoWidget>) => {
    setSujo(true);
    setConfig((c) => ({ ...c, ...patch }));
  };

  const salvar = async () => {
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/channels/site-chat/${canal.id}`, { nome: nome.trim(), config: proposta });
      toast.success(t("Chat do site salvo. O site mostra a mudança na próxima carga de página."));
      setSujo(false);
      await qc.invalidateQueries({ queryKey: CHAVE_DA_CONSULTA });
      await qc.invalidateQueries({ queryKey: ["channel-sessions"] });
    } catch (err) {
      toast.error(mensagemDeErro(err, "Não foi possível salvar o chat do site.", t));
    } finally {
      setSalvando(false);
    }
  };

  const confirmarExclusao = async () => {
    setExcluindo(true);
    try {
      await apiClient.delete(`/api/v1/channel-sessions/${canal.id}`);
      toast.success(t("Chat do site excluído. O balão já saiu do ar."));
      setExcluir(false);
      await qc.invalidateQueries({ queryKey: CHAVE_DA_CONSULTA });
      await qc.invalidateQueries({ queryKey: ["channel-sessions"] });
    } catch (err) {
      toast.error(mensagemDeErro(err, "Não foi possível excluir o chat do site.", t));
    } finally {
      setExcluindo(false);
    }
  };

  const rotuloDoModo = (m: ModoDoCampo): string =>
    m === "oculto" ? t("Não pedir") : m === "opcional" ? t("Pedir, sem obrigar") : t("Obrigatório");

  return (
    <Card className="flex flex-col gap-5 p-4" data-testid="site-chat-editor">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{canal.nome}</h3>
          <p className="text-xs text-muted-foreground">
            {t("As mensagens deste chat entram no Inbox como conversas novas.")}
          </p>
        </div>
        <SinalDeInstalacao canal={canal} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`sc-nome-${canal.id}`}>{t("Nome do chat (só você vê)")}</Label>
            <Input
              id={`sc-nome-${canal.id}`}
              value={nome}
              maxLength={60}
              onChange={(e) => {
                setSujo(true);
                setNome(e.target.value);
              }}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`sc-titulo-${canal.id}`}>{t("Título do chat")}</Label>
              <Input
                id={`sc-titulo-${canal.id}`}
                value={config.titulo}
                maxLength={60}
                onChange={(e) => mudar({ titulo: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`sc-subtitulo-${canal.id}`}>{t("Frase abaixo do título")}</Label>
              <Input
                id={`sc-subtitulo-${canal.id}`}
                value={config.subtitulo}
                maxLength={120}
                onChange={(e) => mudar({ subtitulo: e.target.value })}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`sc-boas-${canal.id}`}>{t("Mensagem de boas-vindas")}</Label>
            <Textarea
              id={`sc-boas-${canal.id}`}
              value={config.mensagem_de_boas_vindas}
              maxLength={500}
              rows={2}
              onChange={(e) => mudar({ mensagem_de_boas_vindas: e.target.value })}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`sc-cor-${canal.id}`}>{t("Cor principal")}</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={t("Escolher a cor principal")}
                  value={corValida ? config.cor_principal : "#2563eb"}
                  onChange={(e) => mudar({ cor_principal: e.target.value })}
                  className="h-9 w-11 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
                  data-testid="site-chat-cor"
                />
                <Input
                  id={`sc-cor-${canal.id}`}
                  value={config.cor_principal}
                  maxLength={7}
                  onChange={(e) => mudar({ cor_principal: e.target.value })}
                  aria-invalid={!corValida}
                  className="font-mono"
                />
              </div>
              {!corValida && <p className="text-xs text-error-fg">{t("Use um código de cor como #2563eb.")}</p>}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>{t("Posição na tela")}</Label>
              <Select value={config.posicao} onValueChange={(v) => mudar({ posicao: v as ConfigDoWidget["posicao"] })}>
                <SelectTrigger aria-label={t("Posição na tela")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POSICOES_DO_WIDGET.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p === "direita" ? t("Canto direito") : t("Canto esquerdo")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>{t("Idioma dos botões")}</Label>
              <Select value={config.idioma} onValueChange={(v) => mudar({ idioma: v as ConfigDoWidget["idioma"] })}>
                <SelectTrigger aria-label={t("Idioma dos botões")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IDIOMAS_DO_WIDGET.map((i) => (
                    <SelectItem key={i} value={i}>
                      {i === "pt" ? t("Português") : i === "es" ? t("Espanhol") : t("Inglês")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{t("Antes de começar a conversa, pedir:")}</legend>
            <p className="text-xs text-muted-foreground">
              {t(
                "Quem fecha a aba do site some. Com telefone ou e-mail, o atendente e o follow-up conseguem continuar a conversa depois.",
              )}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {(
                [
                  ["nome", t("Nome")],
                  ["email", t("E-mail")],
                  ["telefone", t("Telefone")],
                ] as const
              ).map(([campo, rotulo]) => (
                <div key={campo} className="flex flex-col gap-1.5">
                  <Label>{rotulo}</Label>
                  <Select
                    value={config.formulario_inicial[campo]}
                    onValueChange={(v) =>
                      mudar({ formulario_inicial: { ...config.formulario_inicial, [campo]: v as ModoDoCampo } })
                    }
                  >
                    <SelectTrigger aria-label={`${t("Pedir")} ${rotulo}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODOS_DO_CAMPO.map((m) => (
                        <SelectItem key={m} value={m}>
                          {rotuloDoModo(m)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`sc-dominios-${canal.id}`}>{t("Sites autorizados (opcional)")}</Label>
            <Textarea
              id={`sc-dominios-${canal.id}`}
              value={dominios}
              rows={2}
              placeholder={"exemplo.com.br\nloja.exemplo.com.br"}
              onChange={(e) => {
                setSujo(true);
                setDominios(e.target.value);
              }}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "Um endereço por linha, sem https://. Em branco, o chat funciona em qualquer site onde o código for colado.",
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={salvar} disabled={salvando || !mudou || !corValida} data-testid="site-chat-salvar">
              {salvando ? t("Salvando…") : t("Salvar")}
            </Button>
            <Button
              variant="ghost"
              className="text-error-fg hover:text-error-fg"
              onClick={() => setExcluir(true)}
              data-testid="site-chat-excluir"
            >
              <Trash size={14} aria-hidden />
              {t("Excluir chat")}
            </Button>
          </div>
        </div>

        <PreviaDoWidget config={proposta} corValida={corValida} />
      </div>

      <Instalacao canal={canal} />

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <h4 className="text-sm font-semibold">{t("Agente de IA neste chat")}</h4>
        <p className="text-xs text-muted-foreground">
          {t(
            "Todo canal novo nasce com a IA em modo de teste. No chat do site, o modo de teste só reconhece o visitante que informar, no formulário do chat, um telefone da lista de teste. Para a IA responder qualquer visitante, abra-a ao público.",
          )}
        </p>
        <ChannelAiAccess channelId={canal.id} />
      </div>

      <AlertDialog open={excluir} onOpenChange={(o) => !excluindo && setExcluir(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Excluir o chat")} “{canal.nome}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "O balão some do site na hora, mesmo com o código ainda colado lá. As conversas já recebidas continuam no Inbox. Não há desfazer: para voltar a ter chat neste site, será preciso criar outro e colar o código novo.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={excluindo}>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={excluindo}
              onClick={(e) => {
                // O diálogo fecha sozinho no clique; segurar até o servidor
                // responder evita "excluído" na tela com a exclusão recusada.
                e.preventDefault();
                void confirmarExclusao();
              }}
              data-testid="site-chat-confirmar-exclusao"
            >
              {excluindo ? t("Excluindo…") : t("Excluir chat")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function haQuantoTempo(iso: string, t: (s: string) => string): string {
  const minutos = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutos < 1) return t("agora há pouco");
  if (minutos < 60) return `${t("há")} ${minutos} ${t("min")}`;
  const horas = Math.round(minutos / 60);
  if (horas < 48) return `${t("há")} ${horas} ${t("h")}`;
  return `${t("há")} ${Math.round(horas / 24)} ${t("dias")}`;
}

function SinalDeInstalacao({ canal }: { canal: CanalDaTela }) {
  const t = useT();
  if (!canal.last_seen) {
    return (
      <Badge variant="outline" data-testid="site-chat-sinal">
        {t("Ainda não instalado")}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" data-testid="site-chat-sinal">
      {t("Instalado")}
      {canal.last_seen.site ? ` · ${canal.last_seen.site}` : ""} · {haQuantoTempo(canal.last_seen.at, t)}
    </Badge>
  );
}

function Instalacao({ canal }: { canal: CanalDaTela }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <h4 className="text-sm font-semibold">{t("Instalar no site")}</h4>
      <p className="text-xs text-muted-foreground">
        {t("Copie o código abaixo e cole em todas as páginas do seu site, logo antes de")}{" "}
        <code className="rounded-sm bg-muted px-1">{"</body>"}</code>.{" "}
        {t("Em WordPress, Wix, Nuvemshop e parecidos, procure por “código personalizado” ou “scripts do rodapé”.")}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <code
          className="flex-1 overflow-x-auto whitespace-pre rounded-md bg-muted px-3 py-2 text-xs"
          data-testid="site-chat-snippet"
        >
          {canal.snippet}
        </code>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await copyToClipboard(canal.snippet);
            toast.success(t("Código copiado."));
          }}
          data-testid="site-chat-copiar"
        >
          {t("Copiar código")}
        </Button>
      </div>
      {!canal.last_seen && (
        <p className="text-xs text-muted-foreground">
          {t(
            "Depois de colar, abra o seu site: em até um minuto esta tela passa a mostrar “Instalado” com o endereço onde o chat apareceu.",
          )}
        </p>
      )}
    </div>
  );
}

/**
 * A prévia — DOM estático com a MESMA geometria do widget de verdade
 * (`public/site-chat/widget.js`): 56px de balão, cabeçalho na cor principal,
 * balão do visitante na cor principal, o do atendente neutro.
 *
 * A cor do texto é CALCULADA com a mesma função que o servidor usa
 * (`melhorFrenteSobre`), então o que a prévia promete de contraste é o que o
 * site entrega — branco sobre amarelo de marca é o defeito que ela existe para
 * mostrar antes de publicar.
 */
function PreviaDoWidget({ config, corValida }: { config: ConfigDoWidget; corValida: boolean }) {
  const t = useT();
  const cor = corValida ? config.cor_principal : "#2563eb";
  const frente = melhorFrenteSobre(cor);
  const pede =
    config.formulario_inicial.nome !== "oculto" ||
    config.formulario_inicial.email !== "oculto" ||
    config.formulario_inicial.telefone !== "oculto";

  return (
    <div className="flex flex-col gap-2" aria-label={t("Prévia do chat")} data-testid="site-chat-previa">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("Prévia")}</span>
      <div
        className={`flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3 ${
          config.posicao === "esquerda" ? "items-start" : "items-end"
        }`}
      >
        <div className="flex w-full max-w-[300px] flex-col overflow-hidden rounded-2xl border border-border bg-white shadow-lg">
          <div className="relative px-4 py-3" style={{ background: cor, color: frente }} data-testid="site-chat-previa-topo">
            <p className="text-[15px] font-semibold leading-tight">{config.titulo || t("Título do chat")}</p>
            {config.subtitulo && <p className="mt-0.5 text-xs opacity-90">{config.subtitulo}</p>}
            <X size={16} className="absolute right-3 top-3 opacity-80" aria-hidden />
          </div>
          <div className="flex flex-col gap-2 bg-neutral-50 p-3 text-[13px] text-neutral-900">
            {config.mensagem_de_boas_vindas && (
              <div className="max-w-[85%] self-start whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-neutral-200 bg-white px-3 py-2">
                {config.mensagem_de_boas_vindas}
              </div>
            )}
            {pede ? (
              <div className="flex flex-col gap-1.5">
                {config.formulario_inicial.nome !== "oculto" && <CampoDaPrevia rotulo={t("Seu nome")} />}
                {config.formulario_inicial.email !== "oculto" && <CampoDaPrevia rotulo={t("Seu e-mail")} />}
                {config.formulario_inicial.telefone !== "oculto" && (
                  <CampoDaPrevia rotulo={t("Seu WhatsApp ou telefone")} />
                )}
                {/* A mensagem é sempre pedida: o formulário ABRE a conversa. */}
                <div className="h-12 rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-400">
                  {t("Escreva sua mensagem…")}
                </div>
                <div
                  className="mt-1 rounded-lg px-3 py-2 text-center text-[13px] font-semibold"
                  style={{ background: cor, color: frente }}
                >
                  {t("Iniciar conversa")}
                </div>
              </div>
            ) : (
              <div
                className="max-w-[85%] self-end rounded-2xl rounded-br-sm px-3 py-2"
                style={{ background: cor, color: frente }}
              >
                {t("Olá! Queria tirar uma dúvida.")}
              </div>
            )}
          </div>
          {!pede && (
            <div className="flex items-center gap-2 border-t border-neutral-200 bg-white px-3 py-2">
              <div className="flex-1 rounded-lg border border-neutral-300 px-2 py-1.5 text-xs text-neutral-400">
                {t("Escreva sua mensagem…")}
              </div>
              <div
                className="flex h-8 w-8 items-center justify-center rounded-full"
                style={{ background: cor, color: frente }}
              >
                <PaperPlaneTilt size={14} weight="fill" aria-hidden />
              </div>
            </div>
          )}
        </div>
        <div
          className="flex h-14 w-14 items-center justify-center rounded-full shadow-lg"
          style={{ background: cor, color: frente }}
          data-testid="site-chat-previa-balao"
        >
          <ChatCircle size={26} weight="fill" aria-hidden />
        </div>
      </div>
    </div>
  );
}

function CampoDaPrevia({ rotulo }: { rotulo: string }) {
  return (
    <div className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-400">{rotulo}</div>
  );
}
