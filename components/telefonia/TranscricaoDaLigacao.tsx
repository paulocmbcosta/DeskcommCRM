"use client";
/**
 * A TRANSCRIÇÃO NO CARTÃO DA LIGAÇÃO (F4 da spec 20; desenho
 * docs/superpowers/specs/2026-10-09-telefonia-transcricao-das-ligacoes-design.md).
 *
 * Embaixo da linha da gravação: "transcrevendo", o RESUMO da ligação e o botão
 * "Ver transcrição" — ou que a gravação não tem fala, ou que a transcrição não
 * saiu. Quem não pode ouvir a gravação não vê nada daqui (e a listagem já nem
 * entrega: `lib/inbox/transcricao-da-ligacao.ts`).
 *
 * O texto inteiro NÃO vem com a conversa. Ele é pedido à rota da LEITURA
 * AUDITADA só no clique — abrir a conversa não conta como ler a transcrição, e
 * cada abertura da janela é uma linha na auditoria, como cada escuta.
 *
 * Duas coisas a tela diz sempre, porque são verdade e quem lê precisa saber: o
 * texto é feito por máquina a partir de áudio de telefone (erra nomes, números e
 * endereços), e QUEM FALOU é estimativa — a gravação mistura as duas vozes.
 */
import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { marcaDeTempo, type FalaDaTranscricao, type QuemFalou, type TranscricaoNoCartao } from "@/lib/telefonia/transcricao";
import { FileText } from "@/lib/ui/icons";

/** O mesmo formato de id que a rota aceita: só uuid vira pedido. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface TranscricaoLida {
  situacao: string;
  resumo: string | null;
  falas: FalaDaTranscricao[];
  duracao_ms: number | null;
}

type Leitura = { fase: "pedindo" } | { fase: "lida"; dados: TranscricaoLida } | { fase: "erro" };

/** Como a tela chama quem falou. `null` = o modelo não soube dizer. */
const NOME_DE_QUEM_FALOU: Record<QuemFalou, string> = {
  atendente: "Atendente",
  cliente: "Cliente",
  sistema: "Gravação automática ou ruído",
};

function Falas({ falas }: { falas: FalaDaTranscricao[] }) {
  const t = useT();
  return (
    <ol className="space-y-3" data-transcricao-falas>
      {falas.map((f, i) => {
        const sistema = f.quem === "sistema";
        return (
          <li key={i} className="space-y-0.5" data-fala-de={f.quem ?? "desconhecido"}>
            <p className="flex items-baseline gap-2 text-xs">
              <span className={sistema ? "font-medium text-muted-foreground" : "font-semibold text-foreground"}>
                {f.quem ? t(NOME_DE_QUEM_FALOU[f.quem]) : t("Não identificado")}
              </span>
              <span className="tabular-nums text-muted-foreground">{marcaDeTempo(f.inicio_ms)}</span>
            </p>
            <p className={`whitespace-pre-wrap text-sm leading-relaxed ${sistema ? "italic text-muted-foreground" : "text-foreground"}`}>
              {f.texto}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function JanelaDaTranscricao({ leitura, aoFechar }: { leitura: Leitura | null; aoFechar: () => void }) {
  const t = useT();
  return (
    <Dialog open={leitura !== null} onOpenChange={(aberta) => (aberta ? undefined : aoFechar())}>
      <DialogContent className="max-h-[85vh] max-w-2xl gap-0 overflow-hidden p-0" data-janela-da-transcricao>
        <DialogHeader className="space-y-1.5 border-b px-6 pb-4 pt-6 text-left">
          <DialogTitle>{t("Transcrição da ligação")}</DialogTitle>
          <DialogDescription>
            {t(
              "Texto feito por máquina a partir do áudio do telefone: pode errar nomes, números e endereços. Quem falou é uma estimativa. Na dúvida, ouça a gravação.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto px-6 pb-6 pt-4" data-transcricao-corpo={leitura?.fase ?? "fechada"}>
          {!leitura || leitura.fase === "pedindo" ? (
            <p className="text-sm text-muted-foreground">{t("Abrindo a transcrição…")}</p>
          ) : leitura.fase === "erro" ? (
            <p className="text-sm text-muted-foreground" role="alert">
              {t("Não foi possível abrir a transcrição. Feche e tente de novo.")}
            </p>
          ) : leitura.dados.situacao !== "pronta" || leitura.dados.falas.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Esta ligação não tem transcrição para mostrar.")}</p>
          ) : (
            <div className="space-y-4">
              {leitura.dados.resumo ? (
                <div className="rounded-md bg-muted/50 p-3" data-transcricao-resumo>
                  <p className="text-xs font-medium text-muted-foreground">{t("Resumo feito por IA")}</p>
                  <p className="mt-1 text-sm leading-relaxed text-foreground">{leitura.dados.resumo}</p>
                </div>
              ) : null}
              <Falas falas={leitura.dados.falas} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A linha da transcrição no cartão. `podeLer` é o piso de papel de quem ouve a
 * gravação (`voice.recording.listen`): sem ele, nada — nem que a ligação foi
 * transcrita.
 */
export function LinhaDaTranscricao({
  vcId,
  transcricao,
  podeLer,
}: {
  vcId: string;
  transcricao: TranscricaoNoCartao;
  podeLer: boolean;
}) {
  const t = useT();
  // `null` = a janela está fechada. O pedido sai do CLIQUE, nunca de abrir a
  // conversa nem de um efeito: um clique, uma leitura, uma linha na auditoria.
  const [leitura, setLeitura] = useState<Leitura | null>(null);
  const classe = "max-w-full px-4 text-center text-xs leading-snug text-muted-foreground";
  const abrir = async () => {
    setLeitura({ fase: "pedindo" });
    try {
      const r = await apiClient.get<{ data: TranscricaoLida }>(
        `/api/v1/telefonia/chamadas/${encodeURIComponent(vcId)}/transcricao`,
      );
      // Fechou enquanto carregava: a resposta não reabre a janela.
      setLeitura((atual) => (atual === null ? null : { fase: "lida", dados: r.data }));
    } catch {
      setLeitura((atual) => (atual === null ? null : { fase: "erro" }));
    }
  };

  if (!podeLer || !UUID.test(vcId)) return null;
  if (transcricao.situacao === "processando") {
    return (
      <p className={classe} data-ligacao-transcricao="processando">
        {t("Transcrevendo a ligação…")}
      </p>
    );
  }
  if (transcricao.situacao === "sem_fala") {
    return (
      <p className={classe} data-ligacao-transcricao="sem_fala">
        {t("A gravação não tem fala para transcrever.")}
      </p>
    );
  }
  if (transcricao.situacao === "falhou") {
    return (
      <p className={classe} data-ligacao-transcricao="falhou">
        {t("Não foi possível transcrever esta ligação.")}
      </p>
    );
  }

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-1.5 px-4" data-ligacao-transcricao="pronta">
      {transcricao.resumo ? (
        <div className="w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-left" data-ligacao-resumo>
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("Resumo da ligação · feito por IA")}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-foreground">{transcricao.resumo}</p>
        </div>
      ) : null}
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60"
        disabled={leitura?.fase === "pedindo"}
        onClick={() => void abrir()}
        data-ver-transcricao
      >
        <FileText size={12} aria-hidden />
        {t("Ver transcrição")}
      </button>
      <JanelaDaTranscricao leitura={leitura} aoFechar={() => setLeitura(null)} />
    </div>
  );
}
