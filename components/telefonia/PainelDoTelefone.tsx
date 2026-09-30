"use client";
/**
 * O que o atendente VÊ do telefone (spec 20 §7): o aviso de ligação chegando
 * (sobre qualquer tela, como a voz do WhatsApp) e o painel da ligação em curso
 * — fixo no canto, não modal, para ele continuar usando o CRM enquanto fala.
 *
 * E, no mesmo canto, POR QUE a ligação que ele fez acabou sem ninguém atender
 * (`ultimoEncerramento.aviso`): a operadora recusando em 0,2 s parecia, para
 * quem discou, um painel que some sem explicação.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import { useTelefonia, type EstadoDaLigacao } from "@/components/telefonia/TelefoniaContext";
import { TransferirLigacao } from "@/components/telefonia/TransferirLigacao";
import { Button } from "@/components/ui/button";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { textoDaTransferencia } from "@/lib/telefonia/texto-da-transferencia";
import { ArrowRight, DotsNine, Microphone, MicrophoneSlash, Phone, PhoneX, X } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

function duracao(desde: number | null, agora: number): string {
  if (!desde) return "0:00";
  const s = Math.max(0, Math.floor((agora - desde) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Toque sintetizado (Web Audio): dois bipes a cada 2 s. O aviso visual é a garantia; o som, reforço. */
function useToque(ativo: boolean) {
  useEffect(() => {
    if (!ativo) return;
    const AudioCtx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const bipe = (quando: number) => {
      const osc = ctx.createOscillator();
      const ganho = ctx.createGain();
      osc.frequency.value = 880;
      ganho.gain.setValueAtTime(0.0001, quando);
      ganho.gain.exponentialRampToValueAtTime(0.15, quando + 0.02);
      ganho.gain.exponentialRampToValueAtTime(0.0001, quando + 0.35);
      osc.connect(ganho).connect(ctx.destination);
      osc.start(quando);
      osc.stop(quando + 0.4);
    };
    const tocar = () => {
      bipe(ctx.currentTime);
      bipe(ctx.currentTime + 0.45);
    };
    tocar();
    const t = setInterval(tocar, 2_000);
    return () => {
      clearInterval(t);
      void ctx.close().catch(() => undefined);
    };
  }, [ativo]);
}

const TECLAS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

/** A frase da transferência (v2) já traduzida, com o nome no lugar — ou `null`. */
function useFraseDaTransferencia(ligacao: EstadoDaLigacao | null, agora: number) {
  const t = useT();
  if (!ligacao) return null;
  const f = textoDaTransferencia(ligacao, agora);
  if (!f) return null;
  return { texto: t(f.texto).replace("{nome}", f.nome ?? t("colega")), tom: f.tom };
}

/** Quanto tempo o aviso do fim da saída fica na tela sem ninguém fechar. */
const AVISO_NA_TELA_MS = 20_000;

export function PainelDoTelefone() {
  const { ligacao, ultimoEncerramento, atender, desligar, alternarMudo, teclar, decidirConsulta } = useTelefonia();
  const t = useT();
  // O aviso é de UM encerramento: guardar qual foi fechado faz o próximo
  // aparecer sem efeito para "resetar".
  const [avisoFechadoEm, setAvisoFechadoEm] = useState<number | null>(null);
  const aviso = ultimoEncerramento?.aviso && ultimoEncerramento.em !== avisoFechadoEm ? ultimoEncerramento : null;
  useEffect(() => {
    if (!aviso) return;
    const em = aviso.em;
    const relogio = setTimeout(() => setAvisoFechadoEm(em), AVISO_NA_TELA_MS);
    return () => clearTimeout(relogio);
  }, [aviso]);
  const [agora, setAgora] = useState(() => Date.now());
  // O teclado é da LIGAÇÃO: guardar o id de quem o abriu faz a próxima ligação
  // começar com ele fechado sem precisar de efeito para "resetar".
  const [tecladoDe, setTecladoDe] = useState<string | null>(null);
  const teclado = ligacao !== null && tecladoDe === (ligacao.id ?? "sem-id");
  const setTeclado = (f: (v: boolean) => boolean) =>
    setTecladoDe(f(teclado) ? (ligacao?.id ?? "sem-id") : null);

  const tocando = ligacao?.fase === "tocando";
  useToque(tocando);
  // O seletor da transferência é da LIGAÇÃO, como o teclado.
  const [transferirDe, setTransferirDe] = useState<string | null>(null);
  const transferindo = ligacao !== null && transferirDe === (ligacao.id ?? "sem-id");
  const frase = useFraseDaTransferencia(ligacao, agora);

  useEffect(() => {
    if (ligacao?.fase !== "em_ligacao") return;
    const i = setInterval(() => setAgora(Date.now()), 1_000);
    return () => clearInterval(i);
  }, [ligacao?.fase]);

  if (!ligacao) {
    if (!aviso?.aviso) return null;
    return (
      <div
        role="status"
        data-telefonia="aviso-do-fim"
        className="fixed bottom-4 right-4 z-50 flex w-[min(320px,calc(100%-2rem))] items-start gap-3 rounded-xl border border-destructive/30 bg-popover p-3 shadow-2xl animate-in fade-in slide-in-from-bottom-4"
      >
        <PhoneX size={18} weight="bold" className="mt-0.5 shrink-0 text-destructive" aria-hidden />
        <p className="min-w-0 flex-1 text-sm">{t(aviso.aviso)}</p>
        <Button
          variant="ghost"
          size="icon"
          className="-mr-1 -mt-1 h-7 w-7 shrink-0"
          aria-label={t("Fechar aviso")}
          onClick={() => setAvisoFechadoEm(aviso.em)}
        >
          <X size={14} aria-hidden />
        </Button>
      </div>
    );
  }
  // A interna (v3): o colega pelo nome e pelo ramal — "Ana (201)"; o ramal não é telefone para formatar.
  const quem = ligacao.interna
    ? ligacao.nome
      ? `${ligacao.nome} (${ligacao.numero})`
      : t("Ramal {n}").replace("{n}", ligacao.numero)
    : ligacao.nome || phoneForDisplay(ligacao.numero) || t("Número não identificado");
  const inicial = (quem.trim().charAt(0) || "?").toUpperCase();

  if (tocando) {
    return (
      <div
        role="alertdialog"
        aria-label={t("Ligação recebida")}
        data-telefonia="tocando"
        className="fixed inset-x-0 top-4 z-50 mx-auto flex w-[min(420px,calc(100%-2rem))] items-center gap-4 rounded-xl border border-border bg-popover p-4 shadow-2xl animate-in fade-in slide-in-from-top-4"
      >
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/15 text-base font-semibold text-primary">
          {inicial}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {ligacao.interna ? t("Ligação interna") : t("Ligação recebida")}
          </p>
          <p className="truncate text-base font-semibold">{quem}</p>
          {ligacao.nome && !ligacao.interna ? <p className="truncate text-sm text-muted-foreground">{phoneForDisplay(ligacao.numero)}</p> : null}
          {frase ? (
            <p data-telefonia-transferencia className="truncate text-xs font-medium text-primary">
              {frase.texto}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="destructive" size="icon" aria-label={t("Recusar")} onClick={desligar}>
            <PhoneX size={18} weight="bold" aria-hidden />
          </Button>
          <Button size="icon" aria-label={t("Atender")} className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={atender}>
            <Phone size={18} weight="bold" aria-hidden />
          </Button>
        </div>
      </div>
    );
  }

  // A consulta (v2) de quem transfere: [Completar] e [Voltar] no lugar de [Transferir].
  const emConsulta = ligacao.transferencia?.tipo === "attended" && ligacao.papelDaEntrada !== "consulta";
  // Só a ligação atendida, com id, sem transferência aberta — e nunca a interna (D16).
  const podeTransferir =
    ligacao.fase === "em_ligacao" && Boolean(ligacao.id) && !ligacao.transferencia && ligacao.papelDaEntrada !== "consulta" && !ligacao.interna;

  const situacao =
    ligacao.fase === "em_ligacao"
      ? duracao(ligacao.atendidaEm, agora)
      : ligacao.fase === "chamando"
        ? t("Chamando…")
        : t("Conectando…");

  return (
    <div
      role="region"
      aria-label={t("Ligação em andamento")}
      data-telefonia={ligacao.fase}
      className="fixed bottom-4 right-4 z-50 w-[min(320px,calc(100%-2rem))] rounded-xl border border-border bg-popover p-3 shadow-2xl animate-in fade-in slide-in-from-bottom-4"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
          {inicial}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{quem}</p>
          <p className="text-xs tabular-nums text-muted-foreground" data-telefonia-situacao>
            {ligacao.interna ? t("Interna") : ligacao.direcao === "entrada" ? t("Recebida") : t("Feita")} · {situacao}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={ligacao.mudo ? t("Ligar microfone") : t("Silenciar microfone")}
            aria-pressed={ligacao.mudo}
            onClick={alternarMudo}
          >
            {ligacao.mudo ? <MicrophoneSlash size={18} aria-hidden /> : <Microphone size={18} aria-hidden />}
          </Button>
          <Button variant="ghost" size="icon" aria-label={t("Teclado")} aria-pressed={teclado} onClick={() => setTeclado((v) => !v)}>
            <DotsNine size={18} aria-hidden />
          </Button>
          <Button variant="destructive" size="icon" aria-label={t("Desligar")} onClick={desligar}>
            <PhoneX size={18} weight="bold" aria-hidden />
          </Button>
        </div>
      </div>
      {frase ? (
        <p
          data-telefonia-transferencia
          role={frase.tom === "erro" ? "alert" : "status"}
          className={`mt-2 text-xs ${frase.tom === "erro" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {frase.texto}
        </p>
      ) : null}
      {emConsulta ? (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            className="h-8 flex-1 text-xs"
            disabled={ligacao.transferencia?.consulta !== "falando"}
            onClick={() => void decidirConsulta("completar")}
          >
            {t("Completar transferência")}
          </Button>
          <Button size="sm" variant="outline" className="h-8 flex-1 text-xs" onClick={() => void decidirConsulta("voltar")}>
            {t("Voltar ao cliente")}
          </Button>
        </div>
      ) : podeTransferir ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-2 h-8 w-full gap-1.5 text-xs"
          aria-expanded={transferindo}
          onClick={() => setTransferirDe(transferindo ? null : (ligacao.id ?? "sem-id"))}
        >
          <ArrowRight size={14} aria-hidden />
          {t("Transferir")}
        </Button>
      ) : null}
      {transferindo && podeTransferir ? <TransferirLigacao onFechar={() => setTransferirDe(null)} /> : null}
      {teclado ? (
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          {TECLAS.map((k) => (
            <Button key={k} variant="outline" className="h-9 text-base tabular-nums" onClick={() => teclar(k)}>
              {k}
            </Button>
          ))}
        </div>
      ) : null}
      {ligacao.conversaId ? (
        <Link
          href={`/app/inbox?id=${ligacao.conversaId}`}
          className="mt-2 block text-center text-xs font-medium text-primary hover:underline"
        >
          {t("Abrir a conversa")}
        </Link>
      ) : null}
    </div>
  );
}
