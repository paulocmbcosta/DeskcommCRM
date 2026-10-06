"use client";
/**
 * A JANELA DE ENCERRAMENTO (migration 0293).
 *
 * Substitui o `confirm()` do navegador, que fechava o atendimento sem dizer do
 * que ele tratou. Pede três coisas: o SETOR do assunto, o ASSUNTO e o RESUMO.
 *
 * ═══ Cinco decisões que não são óbvias ═══
 *
 * 1. O SETOR É DO ASSUNTO, NÃO DO ATENDIMENTO. Ele vem preenchido com o time do
 *    atendimento, mas escolher outro aqui NÃO transfere a conversa: o cliente
 *    pode ter falado com o Comercial sobre um boleto. Um terço dos encerramentos
 *    medidos em produção não tinha time nenhum — nesses, é aqui que a pessoa diz
 *    de que setor era.
 *
 * 2. A REGRA NÃO MORA AQUI. Se assunto e resumo são obrigatórios é decisão da
 *    organização, aplicada por `fn_atendimento_encerrar`. Esta tela confere
 *    antes de mandar por cortesia (`conferirRegistro`) e mostra no CAMPO a
 *    recusa que vier do servidor — nunca num toast.
 *
 * 3. ELA ABRE PREENCHIDA com o que o atendimento já tem. "Reabrir" continua o
 *    mesmo atendimento, e fechá-lo de novo não pode pedir para reescrever o que
 *    já estava escrito.
 *
 * 4. ELA FECHA O ATENDIMENTO EM QUE FOI ABERTA, OU NENHUM. O `confirm()` era
 *    síncrono; esta janela fica aberta enquanto alguém escreve. Se nesse meio
 *    tempo outra pessoa encerra e o cliente volta, a conversa é a mesma mas o
 *    atendimento é OUTRO — e o clique gravaria o resumo do antigo no novo. Por
 *    isso ela guarda o protocolo da abertura e se recusa a enviar quando o
 *    protocolo vigente já não é aquele.
 *
 * 5. O QUE FOI DIGITADO NÃO SE PERDE POR ACIDENTE. Clicar fora não fecha;
 *    recarregar a lista de assuntos não desmonta o formulário; e enquanto o
 *    envio está em curso a janela não fecha — uma recusa que chegasse depois
 *    não teria onde aparecer.
 *
 * Conversa de grupo não tem atendimento (o trigger da 0266 a pula): a janela
 * vira só a confirmação. Contato ANONIMIZADO não recebe resumo — o banco o
 * descartaria, porque texto livre novo sobre quem pediu o apagamento não teria
 * mais quem o apagasse.
 */
import { useMemo, useState } from "react";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { recusaDoServidor, useCloseConversation } from "@/hooks/inbox/useCloseConversation";
import { useOpcoesDeEncerramento } from "@/hooks/inbox/useOpcoesDeEncerramento";
import {
  RESUMO_MAXIMO,
  conferirRegistro,
  fraseDaRecusa,
  rotuloDoAssunto,
  type AssuntoDoAtendimento,
  type OpcoesDeEncerramento,
  type RecusaDoEncerramento,
} from "@/lib/atendimento/encerramento";
import { cn } from "@/lib/utils";

/** O que a janela precisa saber do atendimento que vai fechar. */
export interface AtendimentoAEncerrar {
  team_id: string | null;
  assunto: AssuntoDoAtendimento | null;
  closure_summary: string | null;
}

interface Props {
  conversationId: string;
  expectedRevision?: number;
  /** Para o cabeçalho: de quem é e qual é o protocolo — os da ABERTURA da janela. */
  contato: string;
  protocolo: string | null;
  /** O protocolo vigente da conversa AGORA. Diferente do da abertura = o atendimento é outro. */
  protocoloAtual: string | null;
  /** A conversa já está encerrada agora (outra pessoa fechou com a janela aberta). */
  jaEncerrada: boolean;
  /** O atendimento vigente. `null` enquanto o histórico não chegou. */
  atendimento: AtendimentoAEncerrar | null;
  grupo: boolean;
  /** Contato anonimizado: não se escreve resumo sobre ele. */
  anonimizado: boolean;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/** O setor em que a janela abre: o do assunto já registrado, senão o do atendimento. */
export function setorInicial(
  times: OpcoesDeEncerramento["times"],
  atendimento: AtendimentoAEncerrar | null,
): string {
  const registrado = atendimento?.assunto?.id;
  if (registrado) {
    const dono = times.find((time) => time.assuntos.some((a) => a.id === registrado));
    if (dono) return dono.id;
  }
  if (atendimento?.team_id && times.some((time) => time.id === atendimento.team_id)) return atendimento.team_id;
  // Um setor só: não há o que escolher.
  return times.length === 1 ? times[0]!.id : "";
}

const SEM_OPCOES: OpcoesDeEncerramento = { exigir_assunto: false, exigir_resumo: false, times: [] };

type Envio = ReturnType<typeof useCloseConversation>;

export function EncerrarAtendimentoDialog(props: Props) {
  const t = useT();
  const opcoes = useOpcoesDeEncerramento(props.open && !props.grupo);
  // A mutação mora AQUI, e não no formulário: é ela que diz à janela que não
  // pode fechar enquanto o envio está em curso.
  const envio = useCloseConversation();

  // O esqueleto só aparece na PRIMEIRA carga. Um "Tentar de novo" devolve a
  // consulta ao estado de carregando — e trocar o formulário pelo esqueleto ali
  // apagaria o resumo que a pessoa já tinha escrito.
  const primeiraCarga = opcoes.isLoading && opcoes.errorUpdateCount === 0;
  const opcoesIndisponiveis = !props.grupo && (opcoes.isError || (opcoes.isLoading && !primeiraCarga));

  return (
    <Dialog
      open={props.open}
      onOpenChange={(v) => {
        if (!v && envio.isPending) return;
        props.onOpenChange(v);
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        data-testid="janela-de-encerramento"
        // Clicar fora não fecha: é um formulário, e um clique perdido não pode
        // custar o resumo digitado. Esc e "Cancelar" continuam fechando.
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{props.grupo ? t("Encerrar conversa") : t("Encerrar atendimento")}</DialogTitle>
          <DialogDescription>
            {props.contato}
            {props.protocolo ? (
              <>
                {" · "}
                {t("protocolo")} <span className="font-mono tabular-nums">{props.protocolo}</span>
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {!props.grupo && primeiraCarga ? (
          <div className="space-y-3" data-testid="encerramento-carregando">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          // `key`: trocar de conversa com a janela aberta não pode carregar o
          // texto de um atendimento para o outro.
          <Formulario
            key={props.conversationId}
            {...props}
            envio={envio}
            opcoes={props.grupo ? SEM_OPCOES : (opcoes.data ?? SEM_OPCOES)}
            opcoesIndisponiveis={opcoesIndisponiveis}
            onRecarregarOpcoes={() => void opcoes.refetch()}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Formulario({
  conversationId,
  expectedRevision,
  protocolo,
  protocoloAtual,
  jaEncerrada,
  atendimento,
  grupo,
  anonimizado,
  onOpenChange,
  envio,
  opcoes,
  opcoesIndisponiveis,
  onRecarregarOpcoes,
}: Props & {
  envio: Envio;
  opcoes: OpcoesDeEncerramento;
  opcoesIndisponiveis: boolean;
  onRecarregarOpcoes: () => void;
}) {
  const t = useT();

  const assuntoRegistrado = atendimento?.assunto ?? null;
  const registradoEstaNaLista = opcoes.times.some((time) => time.assuntos.some((a) => a.id === assuntoRegistrado?.id));
  const resumoRegistrado = atendimento?.closure_summary ?? "";

  const [setor, setSetor] = useState(() => setorInicial(opcoes.times, atendimento));
  const [assuntoId, setAssuntoId] = useState<string | null>(() =>
    registradoEstaNaLista ? (assuntoRegistrado?.id ?? null) : null,
  );
  const [resumo, setResumo] = useState(resumoRegistrado);
  const [recusas, setRecusas] = useState<RecusaDoEncerramento[]>([]);

  // O ATENDIMENTO E A LISTA DE ASSUNTOS PODEM CHEGAR DEPOIS DA JANELA. Quem
  // clica em "Reabrir" e logo em "Fechar" abre a janela antes de o histórico
  // recarregar — e ela abriria em branco sobre um atendimento que TEM registro.
  // Quando o dado chega, a janela se preenche; mas só no que a pessoa ainda não
  // mexeu: o que ela escolheu ou digitou vale mais que o que estava guardado.
  //
  // Ajuste de estado DURANTE o render, e não num efeito: é o padrão do React
  // para "o dado de fora mudou", e não pinta um quadro com o valor antigo.
  const [mexeuNoAssunto, setMexeuNoAssunto] = useState(false);
  const [mexeuNoResumo, setMexeuNoResumo] = useState(false);
  const assinatura = [
    atendimento?.team_id ?? "",
    assuntoRegistrado?.id ?? "",
    resumoRegistrado,
    opcoes.times.map((time) => `${time.id}:${time.assuntos.length}`).join(","),
  ].join("|");
  const [assinaturaVista, setAssinaturaVista] = useState(assinatura);
  if (assinatura !== assinaturaVista) {
    setAssinaturaVista(assinatura);
    if (!mexeuNoAssunto) {
      setSetor(setorInicial(opcoes.times, atendimento));
      setAssuntoId(registradoEstaNaLista ? (assuntoRegistrado?.id ?? null) : null);
    }
    if (!mexeuNoResumo) setResumo(resumoRegistrado);
  }

  // O ATENDIMENTO JÁ NÃO É O DA ABERTURA: outra pessoa encerrou, ou encerrou e o
  // cliente voltou (protocolo novo). Nada é enviado — o texto continua na tela,
  // para a pessoa copiar se precisar.
  const outroAtendimento = !grupo && protocolo !== null && protocoloAtual !== null && protocoloAtual !== protocolo;
  const naoEMaisEste = !grupo && (jaEncerrada || outroAtendimento);

  const haAssuntos = opcoes.times.length > 0;
  const assuntosDoSetor = useMemo(
    () => opcoes.times.find((time) => time.id === setor)?.assuntos ?? [],
    [opcoes.times, setor],
  );
  const recusaDe = (campo: RecusaDoEncerramento["campo"]) => recusas.find((r) => r.campo === campo) ?? null;
  const erroDoAssunto = recusaDe("assunto");
  const erroDoResumo = recusaDe("resumo");
  const limpar = (campo: RecusaDoEncerramento["campo"]) =>
    setRecusas((atuais) => atuais.filter((r) => r.campo !== campo));

  function encerrar() {
    if (envio.isPending || naoEMaisEste) return;
    const texto = resumo.trim();
    // O assunto que o atendimento JÁ tem conta: o banco o preserva quando nada
    // é enviado, e cobrar de novo o que já está registrado seria atrito à toa.
    const assuntoEfetivo = assuntoId ?? assuntoRegistrado?.id ?? null;
    const faltas = grupo
      ? []
      : conferirRegistro(
          { assunto_id: assuntoEfetivo, resumo: anonimizado ? null : texto },
          { ...opcoes, exigir_resumo: opcoes.exigir_resumo && !anonimizado },
        );
    if (faltas.length > 0) {
      setRecusas(faltas);
      return;
    }
    // NULO = "não informado", e o banco preserva o que havia. Texto VAZIO é o
    // gesto de apagar — só enviado quando havia um resumo e a pessoa o limpou
    // de propósito. Um campo vazio em que ninguém mexeu nunca apaga nada.
    const resumoEnviado =
      grupo || anonimizado ? null : texto !== "" ? texto : resumoRegistrado !== "" && mexeuNoResumo ? "" : null;
    envio.mutate(
      {
        conversation_id: conversationId,
        expected_revision: expectedRevision,
        assunto_id: grupo ? null : assuntoId,
        resumo: resumoEnviado,
      },
      {
        onSuccess: () => onOpenChange(false),
        onError: (err) => {
          const recusa = recusaDoServidor(err);
          if (!recusa) return;
          setRecusas([recusa]);
          // O servidor cobrou (ou recusou) um assunto: a lista desta tela está
          // defasada em relação ao cadastro. Recarrega, para a pessoa ter o que
          // escolher.
          if (recusa.campo === "assunto") onRecarregarOpcoes();
        },
      },
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        encerrar();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          encerrar();
        }
      }}
    >
      {naoEMaisEste && (
        <p role="alert" className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-fg" data-testid="encerramento-mudou">
          {outroAtendimento
            ? t("Este atendimento já foi encerrado, e o cliente voltou: há um atendimento novo em andamento. Feche esta janela e confira a conversa antes de encerrar.")
            : t("Este atendimento já foi encerrado por outra pessoa. Feche esta janela.")}
        </p>
      )}

      {grupo ? (
        <p className="text-sm text-muted-foreground">{t("A conversa sai da lista de abertas. Dá para reabrir depois.")}</p>
      ) : (
        <>
          {opcoesIndisponiveis && (
            <div className="flex items-center justify-between gap-3 rounded-md bg-surface-elevated px-3 py-2">
              <p className="text-xs text-text-muted">{t("Não consegui carregar os assuntos.")}</p>
              <Button type="button" size="sm" variant="outline" onClick={onRecarregarOpcoes}>
                {t("Tentar de novo")}
              </Button>
            </div>
          )}

          {haAssuntos && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="encerramento-setor">{t("Setor do assunto")}</Label>
                <Select
                  value={setor}
                  onValueChange={(v) => {
                    setMexeuNoAssunto(true);
                    setSetor(v);
                    // Assunto é do setor: trocar de setor com o assunto antigo
                    // marcado gravaria um par que a tela não está mostrando.
                    setAssuntoId(null);
                    limpar("assunto");
                  }}
                >
                  <SelectTrigger id="encerramento-setor" className="w-full" data-testid="encerramento-setor">
                    <SelectValue placeholder={t("Escolha o setor")} />
                  </SelectTrigger>
                  <SelectContent>
                    {opcoes.times.map((time) => (
                      <SelectItem key={time.id} value={time.id}>
                        {time.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("Do que o cliente tratou. Escolher outro setor aqui não transfere a conversa.")}
                </p>
              </div>

              <div className="space-y-1.5">
                <p id="encerramento-assunto-rotulo" className="text-sm font-medium">
                  {t("Assunto")}
                  {opcoes.exigir_assunto && <Obrigatorio />}
                </p>
                {setor === "" ? (
                  <p className="text-xs text-muted-foreground">{t("Escolha o setor para ver os assuntos.")}</p>
                ) : (
                  <div
                    role="radiogroup"
                    aria-labelledby="encerramento-assunto-rotulo"
                    aria-invalid={erroDoAssunto ? true : undefined}
                    className="flex flex-wrap gap-2"
                  >
                    {assuntosDoSetor.map((a) => {
                      const marcado = a.id === assuntoId;
                      return (
                        <button
                          key={a.id}
                          type="button"
                          role="radio"
                          aria-checked={marcado}
                          data-testid="encerramento-assunto"
                          data-assunto-id={a.id}
                          onClick={() => {
                            setMexeuNoAssunto(true);
                            // Desmarcar só existe enquanto o atendimento não tem
                            // assunto: depois disso o banco preserva o registrado
                            // quando nada é enviado, e a tela mostraria "nenhum"
                            // sobre um atendimento que continua com assunto.
                            setAssuntoId(marcado && !assuntoRegistrado ? null : a.id);
                            limpar("assunto");
                          }}
                          className={cn(
                            "rounded-full border px-3 py-1 text-xs transition-colors",
                            marcado
                              ? "border-accent-500 bg-accent-50 font-medium text-accent"
                              : "border-border text-text hover:border-border-strong hover:bg-surface-elevated",
                          )}
                        >
                          {a.name}
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* Assunto registrado que saiu do cadastro (arquivado): continua
                    valendo se nada for escolhido — e a tela diz isso, em vez de
                    parecer que o atendimento não tem assunto. */}
                {assuntoRegistrado && !registradoEstaNaLista && assuntoId === null && (
                  <p className="text-xs text-muted-foreground" data-testid="encerramento-assunto-anterior">
                    {t("Registrado antes")}: {rotuloDoAssunto(assuntoRegistrado)}
                  </p>
                )}
              </div>
            </>
          )}

          {/* FORA do bloco dos assuntos de propósito: o servidor pode cobrar o
              assunto quando esta tela ainda não tem lista (falhou ao carregar,
              ou o cadastro mudou há um minuto). Sem isto o botão pareceria não
              fazer nada — o toast é suprimido para a recusa do registro. */}
          {erroDoAssunto && (
            <p role="alert" className="text-xs text-error-fg" data-testid="encerramento-erro-assunto">
              {t(fraseDaRecusa(erroDoAssunto))}
            </p>
          )}

          {anonimizado ? (
            <p className="rounded-md bg-surface-elevated px-3 py-2 text-xs text-text-muted" data-testid="encerramento-sem-resumo">
              {t("Este contato foi anonimizado: o resumo não é guardado.")}
            </p>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="encerramento-resumo">
                {t("Resumo do atendimento")}
                {opcoes.exigir_resumo && <Obrigatorio />}
              </Label>
              <Textarea
                id="encerramento-resumo"
                data-testid="encerramento-resumo"
                rows={4}
                value={resumo}
                maxLength={RESUMO_MAXIMO}
                aria-invalid={erroDoResumo ? true : undefined}
                placeholder={t("O que o cliente precisava e o que foi feito.")}
                onChange={(e) => {
                  setMexeuNoResumo(true);
                  setResumo(e.target.value);
                  limpar("resumo");
                }}
              />
              <div className="flex items-start justify-between gap-3">
                {erroDoResumo ? (
                  <p role="alert" className="text-xs text-error-fg" data-testid="encerramento-erro-resumo">
                    {t(fraseDaRecusa(erroDoResumo))}
                  </p>
                ) : (
                  <span />
                )}
                <span className="shrink-0 text-[11px] tabular-nums text-text-muted">
                  {resumo.length} / {RESUMO_MAXIMO}
                </span>
              </div>
            </div>
          )}
        </>
      )}

      <DialogFooter>
        {/* Travado durante o envio: fechar agora esconderia uma recusa que ainda
            está a caminho. */}
        <Button type="button" variant="ghost" disabled={envio.isPending} onClick={() => onOpenChange(false)}>
          {naoEMaisEste ? t("Fechar janela") : t("Cancelar")}
        </Button>
        <Button type="submit" disabled={envio.isPending || naoEMaisEste} data-testid="encerramento-confirmar">
          {envio.isPending ? t("Encerrando…") : grupo ? t("Encerrar conversa") : t("Encerrar atendimento")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Obrigatorio() {
  const t = useT();
  return (
    <span className="ml-1 text-error-fg" title={t("Obrigatório")} aria-label={t("Obrigatório")}>
      *
    </span>
  );
}
