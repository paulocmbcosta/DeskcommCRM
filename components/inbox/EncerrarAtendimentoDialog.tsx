"use client";
/**
 * A JANELA DE ENCERRAMENTO (migration 0293).
 *
 * Substitui o `confirm()` do navegador, que fechava o atendimento sem dizer do
 * que ele tratou. Pede três coisas: o SETOR do assunto, o ASSUNTO e o RESUMO.
 *
 * ═══ Três decisões que não são óbvias ═══
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
 * Conversa de grupo não tem atendimento (o trigger da 0266 a pula): a janela
 * vira só a confirmação.
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
  /** Para o cabeçalho: de quem é e qual é o protocolo. */
  contato: string;
  protocolo: string | null;
  /** O atendimento vigente. `null` enquanto o histórico não chegou. */
  atendimento: AtendimentoAEncerrar | null;
  grupo: boolean;
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

export function EncerrarAtendimentoDialog(props: Props) {
  const t = useT();
  const opcoes = useOpcoesDeEncerramento(props.open && !props.grupo);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="janela-de-encerramento">
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

        {props.grupo ? (
          <Formulario {...props} opcoes={SEM_OPCOES} />
        ) : opcoes.isLoading ? (
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
            opcoes={opcoes.data ?? SEM_OPCOES}
            opcoesIndisponiveis={opcoes.isError}
            onTentarDeNovo={() => void opcoes.refetch()}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

const SEM_OPCOES: OpcoesDeEncerramento = { exigir_assunto: false, exigir_resumo: false, times: [] };

function Formulario({
  conversationId,
  expectedRevision,
  atendimento,
  grupo,
  onOpenChange,
  opcoes,
  opcoesIndisponiveis = false,
  onTentarDeNovo,
}: Props & { opcoes: OpcoesDeEncerramento; opcoesIndisponiveis?: boolean; onTentarDeNovo?: () => void }) {
  const t = useT();
  const close = useCloseConversation();

  const assuntoRegistrado = atendimento?.assunto ?? null;
  const registradoEstaNaLista = opcoes.times.some((time) => time.assuntos.some((a) => a.id === assuntoRegistrado?.id));

  const [setor, setSetor] = useState(() => setorInicial(opcoes.times, atendimento));
  const [assuntoId, setAssuntoId] = useState<string | null>(() =>
    registradoEstaNaLista ? (assuntoRegistrado?.id ?? null) : null,
  );
  const [resumo, setResumo] = useState(atendimento?.closure_summary ?? "");
  const [recusas, setRecusas] = useState<RecusaDoEncerramento[]>([]);

  // O ATENDIMENTO PODE CHEGAR DEPOIS DA JANELA. Quem clica em "Reabrir" e logo
  // em "Fechar" abre a janela antes de o histórico recarregar — e ela abriria
  // em branco sobre um atendimento que TEM registro. Quando o dado chega, a
  // janela se preenche; mas só se a pessoa ainda não mexeu em nada: o que ela
  // digitou vale mais que o que estava guardado.
  //
  // Ajuste de estado DURANTE o render, e não num efeito: é o padrão do React
  // para "o dado de fora mudou", e não pinta um quadro com o valor antigo.
  const [mexeu, setMexeu] = useState(false);
  const assinatura = `${atendimento?.team_id ?? ""}|${assuntoRegistrado?.id ?? ""}|${atendimento?.closure_summary ?? ""}`;
  const [assinaturaVista, setAssinaturaVista] = useState(assinatura);
  if (assinatura !== assinaturaVista) {
    setAssinaturaVista(assinatura);
    if (!mexeu) {
      setSetor(setorInicial(opcoes.times, atendimento));
      setAssuntoId(registradoEstaNaLista ? (assuntoRegistrado?.id ?? null) : null);
      setResumo(atendimento?.closure_summary ?? "");
    }
  }

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
    if (close.isPending) return;
    // O assunto que o atendimento JÁ tem conta: o banco o preserva quando nada
    // é enviado, e cobrar de novo o que já está registrado seria atrito à toa.
    const assuntoEfetivo = assuntoId ?? assuntoRegistrado?.id ?? null;
    const faltas = grupo
      ? []
      : conferirRegistro({ assunto_id: assuntoEfetivo, resumo }, opcoes);
    if (faltas.length > 0) {
      setRecusas(faltas);
      return;
    }
    close.mutate(
      {
        conversation_id: conversationId,
        expected_revision: expectedRevision,
        assunto_id: grupo ? null : assuntoId,
        resumo: grupo ? null : resumo.trim() || null,
      },
      {
        onSuccess: () => onOpenChange(false),
        onError: (err) => {
          const recusa = recusaDoServidor(err);
          if (recusa) setRecusas([recusa]);
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
      {grupo ? (
        <p className="text-sm text-muted-foreground">{t("A conversa sai da lista de abertas. Dá para reabrir depois.")}</p>
      ) : (
        <>
          {opcoesIndisponiveis && (
            <div className="flex items-center justify-between gap-3 rounded-md bg-surface-elevated px-3 py-2">
              <p className="text-xs text-text-muted">{t("Não consegui carregar os assuntos.")}</p>
              <Button type="button" size="sm" variant="outline" onClick={onTentarDeNovo}>
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
                    setMexeu(true);
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
                            // Desmarcar só existe enquanto o atendimento não tem
                            // assunto: depois disso o banco preserva o registrado
                            // quando nada é enviado, e a tela mostraria "nenhum"
                            // sobre um atendimento que continua com assunto.
                            setMexeu(true);
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
                {erroDoAssunto && (
                  <p role="alert" className="text-xs text-error-fg" data-testid="encerramento-erro-assunto">
                    {t(fraseDaRecusa(erroDoAssunto))}
                  </p>
                )}
              </div>
            </>
          )}

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
                setMexeu(true);
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
        </>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          {t("Cancelar")}
        </Button>
        <Button type="submit" disabled={close.isPending} data-testid="encerramento-confirmar">
          {close.isPending ? t("Encerrando…") : grupo ? t("Encerrar conversa") : t("Encerrar atendimento")}
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
