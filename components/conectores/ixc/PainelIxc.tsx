"use client";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import {
  useDesvincularIxc,
  useEnviarFaturaIxc,
  usePainelIxc,
  useVincularIxc,
} from "@/hooks/conectores/ixc/usePainelIxc";
import { ApiError } from "@/lib/api/types";
import type { Fatura } from "@/lib/conectores/ixc/faturas";
import type { ConexaoIxc, ContratoIxc, Secao } from "@/lib/conectores/ixc/resumo";
import type { Leitura, Tom } from "@/lib/conectores/ixc/vocabulario";
import { copyToClipboard } from "@/lib/clipboard";
import {
  ArrowsClockwise,
  ChatCircle,
  CircleNotch,
  ClipboardText,
  Copy,
  FileText,
  Gauge,
  PaperPlaneTilt,
  Receipt,
  Warning,
  WifiHigh,
} from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * O PAINEL DO IXC — o que o atendente abriria o ERP para ver, na coluna da conversa.
 *
 * A ordem das seções é a ordem das perguntas de um atendimento de provedor:
 * quem é e se está BLOQUEADO (topo, com cor), o que DEVE, como está a CONEXÃO,
 * e o que já está ABERTO para ele (OS e atendimentos). O contrato vem antes do
 * financeiro porque é ele que diz se o bloqueio é por dívida.
 *
 * Cada seção falha SOZINHA: o ERP é de terceiro, e esconder a fatura vencida
 * porque a tabela de OS não respondeu deixaria o atendente pior do que sem painel.
 */

const COR_DO_TOM: Record<Tom, string> = {
  bom: "bg-success-bg text-success-fg",
  atencao: "bg-warning-bg text-warning-fg",
  ruim: "bg-error-bg text-error-fg",
  neutro: "bg-surface-elevated text-text-muted",
};

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function reais(cents: number): string {
  return BRL.format(cents / 100);
}

/** `2026-09-19 14:30:00` → `19/09/2026 14:30`. Sem `Date`: o IXC não manda fuso, e converter inventaria um. */
function dataDoIxc(bruta: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(bruta);
  if (!m) return "";
  const dia = `${m[3]}/${m[2]}/${m[1]}`;
  return m[4] ? `${dia} ${m[4]}:${m[5]}` : dia;
}

function Selo({ leitura }: { leitura: Leitura }) {
  const t = useT();
  return (
    <span className={cn("inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold", COR_DO_TOM[leitura.tom])}>
      {t(leitura.rotulo)}
    </span>
  );
}

function Bloco({
  titulo,
  Icone,
  contador,
  testId,
  children,
}: {
  titulo: string;
  Icone: typeof Receipt;
  contador?: number;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border px-3 py-3" data-testid={testId}>
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        <Icone size={13} aria-hidden />
        <span className="flex-1">{titulo}</span>
        {contador !== undefined && (
          <span className="rounded-full bg-surface-elevated px-1.5 text-[11px] tabular-nums text-text-muted">{contador}</span>
        )}
      </h3>
      {children}
    </section>
  );
}

function Linha({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="shrink-0 text-[11px] text-text-muted">{rotulo}</dt>
      <dd className="min-w-0 break-words text-right text-xs text-text">{children}</dd>
    </div>
  );
}

function SecaoComFalha<T>({ secao, children }: { secao: Secao<T>; children: (dados: T) => ReactNode }) {
  const t = useT();
  if (!secao.ok) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-warning-fg" data-testid="ixc-secao-indisponivel">
        <Warning size={13} className="mt-0.5 shrink-0" aria-hidden />
        {secao.motivo === "recurso_indisponivel"
          ? t("O token do IXC não tem acesso a esta informação.")
          : t("Não consegui ler esta parte no IXC agora.")}
      </p>
    );
  }
  return <>{children(secao.dados)}</>;
}

function LinhaDeFatura({
  fatura,
  contactId,
  conversationId,
}: {
  fatura: Fatura;
  contactId: string;
  conversationId: string | null;
}) {
  const t = useT();
  const enviar = useEnviarFaturaIxc(contactId);
  // Dois toques: mandar mensagem a uma pessoa é irreversível, e o botão mora
  // numa coluna estreita, ao lado de outros iguais.
  const [confirmando, setConfirmando] = useState(false);
  useEffect(() => {
    if (!confirmando) return;
    const id = window.setTimeout(() => setConfirmando(false), 5_000);
    return () => window.clearTimeout(id);
  }, [confirmando]);

  const vencida = fatura.situacao === "vencida";
  return (
    <li className="flex items-center gap-2 py-1.5" data-testid={vencida ? "ixc-fatura-vencida" : "ixc-fatura-a-vencer"}>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold tabular-nums text-text">{reais(fatura.valorCents)}</span>
          <span className={cn("text-[11px] tabular-nums", vencida ? "text-error-fg" : "text-text-muted")}>
            {dataDoIxc(fatura.vencimento)}
          </span>
        </div>
        <p className="text-[11px] text-text-subtle">
          {vencida
            ? fatura.diasDeAtraso === 1
              ? t("vencida há 1 dia")
              : `${t("vencida há")} ${fatura.diasDeAtraso} ${t("dias")}`
            : t("a vencer")}
          {!fatura.enviavel && ` · ${t("boleto ainda não gerado")}`}
        </p>
      </div>
      {fatura.enviavel && (
        <Button
          size="sm"
          variant={confirmando ? "default" : "outline"}
          className="h-7 shrink-0 gap-1 px-2 text-[11px]"
          disabled={!conversationId || enviar.isPending}
          data-testid="ixc-enviar-fatura"
          onClick={() => {
            if (!conversationId) return;
            if (!confirmando) {
              setConfirmando(true);
              return;
            }
            setConfirmando(false);
            enviar.mutate(
              { faturaId: fatura.id, conversationId },
              {
                onSuccess: (res) => {
                  // A primeira mensagem pode sair e a segunda não: dizer "enviada"
                  // deixaria o cliente sem a linha digitável e o atendente sem saber.
                  if (res.data.mensagens_enviadas < res.data.mensagens_previstas) {
                    toast.warning(t("A fatura saiu incompleta: confira a conversa e envie de novo."));
                  } else {
                    toast.success(t("Fatura enviada na conversa."));
                  }
                },
                onError: (err) =>
                  toast.error(err instanceof ApiError && err.message ? err.message : t("Não consegui enviar a fatura.")),
              },
            );
          }}
        >
          {enviar.isPending ? (
            <CircleNotch size={12} className="animate-spin" aria-hidden />
          ) : (
            <PaperPlaneTilt size={12} aria-hidden />
          )}
          {confirmando ? t("Confirmar envio") : t("Enviar")}
        </Button>
      )}
    </li>
  );
}

function CartaoDeContrato({ contrato }: { contrato: ContratoIxc }) {
  const t = useT();
  return (
    <div className="rounded-md border border-border px-2 py-2" data-testid="ixc-contrato">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words text-xs font-medium text-text">{contrato.plano || `${t("Contrato")} ${contrato.id}`}</span>
        <Selo leitura={contrato.status} />
      </div>
      <dl className="mt-1">
        <Linha rotulo={t("Acesso")}>
          <Selo leitura={contrato.acesso} />
        </Linha>
        {contrato.acesso.detalhe && <Linha rotulo={t("Motivo")}>{t(contrato.acesso.detalhe)}</Linha>}
        {contrato.parcelasEmAtraso > 0 && (
          <Linha rotulo={t("Parcelas em atraso")}>
            <span className="font-semibold text-error-fg">{contrato.parcelasEmAtraso}</span>
          </Linha>
        )}
        {contrato.desbloqueioDeConfiancaAtivo && <Linha rotulo={t("Desbloqueio de confiança")}>{t("Ativo agora")}</Linha>}
        {contrato.ativadoEm && <Linha rotulo={t("Ativado em")}>{dataDoIxc(contrato.ativadoEm)}</Linha>}
        {contrato.endereco && <Linha rotulo={t("Instalação")}>{contrato.endereco}</Linha>}
        <Linha rotulo={t("Nº do contrato")}>
          <span className="tabular-nums">{contrato.id}</span>
        </Linha>
      </dl>
    </div>
  );
}

function CartaoDeConexao({ conexao }: { conexao: ConexaoIxc }) {
  const t = useT();
  return (
    <div className="rounded-md border border-border px-2 py-2" data-testid="ixc-conexao">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-text">{conexao.login || "—"}</span>
        <Selo leitura={conexao.estado} />
      </div>
      <dl className="mt-1">
        {conexao.ip && (
          <Linha rotulo="IP">
            <span className="font-mono tabular-nums">{conexao.ip}</span>
          </Linha>
        )}
        {conexao.conectouEm && <Linha rotulo={t("Conectou em")}>{dataDoIxc(conexao.conectouEm)}</Linha>}
        {conexao.caiuEm && <Linha rotulo={t("Última queda")}>{dataDoIxc(conexao.caiuEm)}</Linha>}
        {conexao.motivoDaDesconexao && <Linha rotulo={t("Motivo da queda")}>{conexao.motivoDaDesconexao}</Linha>}
      </dl>
      {conexao.sinal && (
        <div className="mt-2 rounded-md bg-surface-elevated px-2 py-1.5" data-testid="ixc-sinal">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[11px] font-medium text-text-muted">
              <Gauge size={12} aria-hidden />
              {t("Sinal da ONU")}
            </span>
            <Selo leitura={conexao.sinal.rx} />
          </div>
          <dl className="mt-1">
            {conexao.sinal.rx.dbm !== null && (
              <Linha rotulo={t("Recebido (RX)")}>
                <span className="tabular-nums">{conexao.sinal.rx.dbm.toFixed(2)} dBm</span>
              </Linha>
            )}
            {conexao.sinal.txDbm !== null && conexao.sinal.txDbm !== 0 && (
              <Linha rotulo={t("Enviado (TX)")}>
                <span className="tabular-nums">{conexao.sinal.txDbm.toFixed(2)} dBm</span>
              </Linha>
            )}
            {conexao.sinal.causaDaUltimaQueda && <Linha rotulo={t("Causa da última queda")}>{conexao.sinal.causaDaUltimaQueda}</Linha>}
            {/* A leitura é GUARDADA pelo IXC, não medida agora — a data diz de quando. */}
            {conexao.sinal.lidoEm && <Linha rotulo={t("Leitura de")}>{dataDoIxc(conexao.sinal.lidoEm)}</Linha>}
          </dl>
        </div>
      )}
    </div>
  );
}

interface Props {
  contactId: string | null;
  conversationId: string | null;
}

export function PainelIxc({ contactId, conversationId }: Props) {
  const t = useT();
  const tagDeIdioma = useTagDeIdioma();
  // Trocar de conversa não pode carregar o cadastro escolhido na anterior: quem
  // garante é a `key` por contato em `PainelDoConector`, que REMONTA este painel.
  const [cadastro, setCadastro] = useState<string | null>(null);
  const [documento, setDocumento] = useState("");

  const painel = usePainelIxc(contactId, cadastro);
  const vincular = useVincularIxc(contactId);
  const desvincular = useDesvincularIxc(contactId);

  const aoFalharVinculo = (err: unknown) =>
    toast.error(err instanceof ApiError && err.message ? err.message : t("Não consegui vincular."));

  const cabecalho = (
    <div className="flex items-center justify-between border-b border-border px-3 py-2">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">IXC</h2>
      <button
        type="button"
        aria-label={t("Atualizar dados do IXC")}
        title={t("Atualizar dados do IXC")}
        data-testid="ixc-atualizar"
        disabled={painel.isFetching}
        onClick={() => painel.refetch()}
        className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-muted hover:bg-surface-elevated hover:text-text disabled:opacity-50"
      >
        <ArrowsClockwise size={12} className={cn(painel.isFetching && "animate-spin")} aria-hidden />
        {painel.data?.estado === "vinculado" &&
          new Date(painel.data.resumo.lidoEm).toLocaleTimeString(tagDeIdioma, { hour: "2-digit", minute: "2-digit" })}
      </button>
    </div>
  );

  if (painel.isLoading) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="painel-ixc" data-estado="carregando">
        {cabecalho}
        <div className="space-y-3 p-3">
          <p className="text-xs text-text-muted">{t("Consultando o IXC…")}</p>
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
    );
  }

  if (painel.isError || !painel.data) {
    const erro = painel.error;
    const motivo = erro instanceof ApiError ? (erro.details as { motivo?: string } | undefined)?.motivo : undefined;
    return (
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="painel-ixc" data-estado="erro">
        {cabecalho}
        <div className="space-y-2 p-3">
          <p className="text-xs text-error-fg">
            {erro instanceof ApiError && erro.message ? erro.message : t("Não consegui consultar o IXC.")}
          </p>
          {(motivo === "credencial_recusada" || motivo === "url_insegura") && (
            <p className="text-[11px] text-text-muted">
              {t("Um administrador precisa conferir a conexão em Configurações › Conectores.")}
            </p>
          )}
          <Button size="sm" variant="outline" onClick={() => painel.refetch()}>
            {t("Tentar de novo")}
          </Button>
        </div>
      </div>
    );
  }

  const estado = painel.data;

  if (estado.estado === "escolher") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="painel-ixc" data-estado="escolher">
        {cabecalho}
        <div className="space-y-2 p-3">
          <p className="text-xs text-text">{t("Este telefone está em mais de um cadastro do IXC. Confirme com o cliente qual é o dele.")}</p>
          <ul className="space-y-1.5">
            {estado.candidatos.map((c) => (
              <li key={c.id} className="rounded-md border border-border px-2 py-2" data-testid="ixc-candidato">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 break-words text-xs font-medium text-text">{c.nome || `${t("Cadastro")} ${c.id}`}</span>
                  <Selo leitura={c.ativo ? { rotulo: "Ativo", tom: "bom" } : { rotulo: "Inativo", tom: "neutro" }} />
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] tabular-nums text-text-muted">{c.documento_parcial}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    disabled={vincular.isPending}
                    onClick={() => vincular.mutate({ cadastro_id: c.id }, { onError: aoFalharVinculo })}
                  >
                    {t("É este")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {estado.ha_mais && <p className="text-[11px] text-text-muted">{t("Há mais cadastros com este telefone. Busque pelo CPF ou CNPJ.")}</p>}
          <BuscaPorDocumento documento={documento} setDocumento={setDocumento} vincular={vincular} aoFalhar={aoFalharVinculo} />
        </div>
      </div>
    );
  }

  if (estado.estado === "nao_encontrado") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="painel-ixc" data-estado="nao_encontrado">
        {cabecalho}
        <div className="space-y-2 p-3">
          <p className="text-xs text-text">
            {estado.procurou_por_telefone
              ? t("Não achei este telefone no IXC. O cliente pode estar escrevendo de outro número.")
              : t("Este contato não tem um telefone que eu possa procurar no IXC.")}
          </p>
          <BuscaPorDocumento documento={documento} setDocumento={setDocumento} vincular={vincular} aoFalhar={aoFalharVinculo} />
        </div>
      </div>
    );
  }

  const seletor = estado.cadastros.length > 1 && (
    <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2" data-testid="ixc-cadastros">
      {estado.cadastros.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-pressed={c.id === estado.cadastro_em_tela}
          onClick={() => setCadastro(c.id)}
          className={cn(
            "max-w-full truncate rounded-full border px-2 py-0.5 text-[11px]",
            c.id === estado.cadastro_em_tela
              ? "border-accent bg-accent-soft text-accent"
              : "border-border text-text-muted hover:bg-surface-elevated",
          )}
        >
          {c.nome || `${t("Cadastro")} ${c.id}`}
        </button>
      ))}
    </div>
  );

  const botaoDesvincular = (
    <button
      type="button"
      className="text-[11px] text-text-subtle underline-offset-2 hover:text-text hover:underline disabled:opacity-50"
      disabled={desvincular.isPending}
      data-testid="ixc-desvincular"
      onClick={() =>
        desvincular.mutate(estado.cadastro_em_tela, {
          onSuccess: () => setCadastro(null),
          onError: () => toast.error(t("Não consegui desfazer o vínculo.")),
        })
      }
    >
      {t("Não é este cliente? Desfazer vínculo")}
    </button>
  );

  if (estado.estado === "vinculo_sem_cadastro") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="painel-ixc" data-estado="vinculo_sem_cadastro">
        {cabecalho}
        {seletor}
        <div className="space-y-2 p-3">
          <p className="text-xs text-text">
            {t("Este contato está ligado a um cadastro que o IXC não devolve mais.")} ({estado.cadastro_em_tela})
          </p>
          {botaoDesvincular}
        </div>
      </div>
    );
  }

  const { resumo } = estado;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="painel-ixc" data-estado="vinculado">
      {cabecalho}
      {seletor}

      <section className="border-b border-border px-3 py-3" data-testid="ixc-cliente">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 break-words text-sm font-semibold text-text">{resumo.cliente.nome || "—"}</span>
          <span data-testid="ixc-situacao">
            <Selo leitura={resumo.situacao} />
          </span>
        </div>
        {resumo.situacao.detalhe && (
          <p className="mt-0.5 text-[11px] font-medium text-error-fg" data-testid="ixc-motivo-do-bloqueio">
            {t("Motivo")}: {t(resumo.situacao.detalhe)}
          </p>
        )}
        <dl className="mt-1">
          {resumo.cliente.documento && (
            <Linha rotulo={resumo.cliente.pessoaJuridica ? "CNPJ" : "CPF"}>
              <span className="inline-flex items-center gap-1">
                <span className="font-mono tabular-nums">{resumo.cliente.documento}</span>
                <button
                  type="button"
                  aria-label={t("Copiar documento")}
                  title={t("Copiar documento")}
                  className="inline-flex h-5 w-5 items-center justify-center rounded-sm text-text-subtle hover:bg-surface-elevated hover:text-text"
                  onClick={async () => {
                    if (await copyToClipboard(resumo.cliente.documento)) toast.success(t("Copiado."));
                    else toast.error(t("Não foi possível copiar."));
                  }}
                >
                  <Copy size={12} aria-hidden />
                </button>
              </span>
            </Linha>
          )}
          <Linha rotulo={t("Cadastro no IXC")}>
            <span className="tabular-nums">{resumo.cliente.id}</span>
            {!resumo.cliente.ativo && <span className="ml-1 text-text-muted">· {t("inativo")}</span>}
          </Linha>
        </dl>
        <div className="mt-1.5">{botaoDesvincular}</div>
      </section>

      <Bloco titulo={t("Contrato")} Icone={FileText} testId="ixc-contratos">
        <SecaoComFalha secao={resumo.contratos}>
          {(contratos) =>
            contratos.length === 0 ? (
              <p className="text-xs text-text-muted">{t("Nenhum contrato neste cadastro.")}</p>
            ) : (
              <div className="space-y-1.5">
                {contratos.map((c) => (
                  <CartaoDeContrato key={c.id} contrato={c} />
                ))}
              </div>
            )
          }
        </SecaoComFalha>
      </Bloco>

      <Bloco titulo={t("Financeiro")} Icone={Receipt} testId="ixc-financeiro">
        <SecaoComFalha secao={resumo.financeiro}>
          {(fin) => (
            <>
              {fin.vencidas.length === 0 ? (
                <p className="text-xs text-success-fg" data-testid="ixc-em-dia">
                  {t("Nenhuma fatura vencida.")}
                </p>
              ) : (
                <>
                  <p className="text-xs text-error-fg" data-testid="ixc-total-vencido">
                    <span className="font-semibold tabular-nums">{reais(fin.totalVencidoCents)}</span>{" "}
                    {fin.vencidas.length === 1 ? t("em 1 fatura vencida") : `${t("em")} ${fin.vencidas.length} ${t("faturas vencidas")}`}
                  </p>
                  <ul className="mt-1 divide-y divide-border/70">
                    {fin.vencidas.map((f) => (
                      <LinhaDeFatura key={f.id} fatura={f} contactId={contactId ?? ""} conversationId={conversationId} />
                    ))}
                  </ul>
                </>
              )}
              {fin.proximas.length > 0 && (
                <>
                  <h4 className="mt-2 text-[11px] font-medium text-text-muted">{t("Próximas a vencer")}</h4>
                  <ul className="divide-y divide-border/70">
                    {fin.proximas.map((f) => (
                      <LinhaDeFatura key={f.id} fatura={f} contactId={contactId ?? ""} conversationId={conversationId} />
                    ))}
                  </ul>
                </>
              )}
              {fin.outrasAVencer > 0 && (
                <p className="mt-1 text-[11px] text-text-subtle" data-testid="ixc-outras-a-vencer">
                  {fin.outrasAVencer === 1
                    ? t("Mais 1 parcela futura no IXC.")
                    : `${t("Mais")} ${fin.outrasAVencer} ${t("parcelas futuras no IXC.")}`}
                </p>
              )}
            </>
          )}
        </SecaoComFalha>
      </Bloco>

      <Bloco titulo={t("Conexão")} Icone={WifiHigh} testId="ixc-conexoes">
        <SecaoComFalha secao={resumo.conexoes}>
          {(conexoes) =>
            conexoes.length === 0 ? (
              <p className="text-xs text-text-muted">{t("Nenhum login de conexão neste cadastro.")}</p>
            ) : (
              <div className="space-y-1.5">
                {conexoes.map((c) => (
                  <CartaoDeConexao key={c.id} conexao={c} />
                ))}
              </div>
            )
          }
        </SecaoComFalha>
      </Bloco>

      <Bloco
        titulo={t("Ordens de serviço abertas")}
        Icone={ClipboardText}
        contador={resumo.ordensDeServico.ok ? resumo.ordensDeServico.dados.total : undefined}
        testId="ixc-os"
      >
        <SecaoComFalha secao={resumo.ordensDeServico}>
          {(os) =>
            os.abertas.length === 0 ? (
              <p className="text-xs text-text-muted">{t("Nenhuma ordem de serviço aberta.")}</p>
            ) : (
              <ul className="space-y-1.5">
                {os.abertas.map((o) => (
                  <li key={o.id} className="rounded-md border border-border px-2 py-1.5" data-testid="ixc-os-item">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] tabular-nums text-text">{o.protocolo || `#${o.id}`}</span>
                      <Selo leitura={o.status} />
                    </div>
                    {o.resumo && <p className="mt-0.5 break-words text-[11px] leading-snug text-text-muted">{o.resumo}</p>}
                    <p className="mt-0.5 text-[11px] tabular-nums text-text-subtle">
                      {o.abertaEm && `${t("Aberta em")} ${dataDoIxc(o.abertaEm)}`}
                      {o.agendadaPara && ` · ${t("Agenda")} ${dataDoIxc(o.agendadaPara)}`}
                    </p>
                  </li>
                ))}
              </ul>
            )
          }
        </SecaoComFalha>
      </Bloco>

      <Bloco
        titulo={t("Atendimentos abertos no IXC")}
        Icone={ChatCircle}
        contador={resumo.atendimentos.ok ? resumo.atendimentos.dados.total : undefined}
        testId="ixc-atendimentos"
      >
        <SecaoComFalha secao={resumo.atendimentos}>
          {(at) =>
            at.abertos.length === 0 ? (
              <p className="text-xs text-text-muted">{t("Nenhum atendimento aberto.")}</p>
            ) : (
              <ul className="space-y-1.5">
                {at.abertos.map((a) => (
                  <li key={a.id} className="rounded-md border border-border px-2 py-1.5" data-testid="ixc-atendimento-item">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 break-words text-xs text-text">{a.titulo || a.protocolo || `#${a.id}`}</span>
                      <Selo leitura={a.status} />
                    </div>
                    {a.criadoEm && <p className="mt-0.5 text-[11px] tabular-nums text-text-subtle">{dataDoIxc(a.criadoEm)}</p>}
                  </li>
                ))}
              </ul>
            )
          }
        </SecaoComFalha>
      </Bloco>
    </div>
  );
}

function BuscaPorDocumento({
  documento,
  setDocumento,
  vincular,
  aoFalhar,
}: {
  documento: string;
  setDocumento: (v: string) => void;
  vincular: ReturnType<typeof useVincularIxc>;
  aoFalhar: (err: unknown) => void;
}) {
  const t = useT();
  const digitos = documento.replace(/\D/g, "");
  const vale = digitos.length === 11 || digitos.length === 14;
  return (
    <form
      className="space-y-1.5 pt-1"
      data-testid="ixc-busca-por-documento"
      onSubmit={(e) => {
        e.preventDefault();
        if (vale) vincular.mutate({ documento }, { onError: aoFalhar });
      }}
    >
      <label htmlFor="ixc-documento" className="text-[11px] font-medium text-text-muted">
        {t("Buscar pelo CPF ou CNPJ do cliente")}
      </label>
      <div className="flex gap-1.5">
        <Input
          id="ixc-documento"
          inputMode="numeric"
          autoComplete="off"
          placeholder="000.000.000-00"
          value={documento}
          onChange={(e) => setDocumento(e.target.value)}
          className="h-8 text-xs"
        />
        <Button type="submit" size="sm" className="h-8 px-2 text-xs" disabled={!vale || vincular.isPending}>
          {vincular.isPending ? <CircleNotch size={12} className="animate-spin" aria-hidden /> : t("Buscar")}
        </Button>
      </div>
    </form>
  );
}
