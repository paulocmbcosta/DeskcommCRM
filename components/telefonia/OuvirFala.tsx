"use client";
/**
 * Toca uma fala SALVA do telefone no navegador — a que as ligações tocam. A rota
 * (`GET /api/v1/telefonia/falas/[id]/audio`) devolve o μ-law (8 kHz) exatamente
 * como o Asterisk o toca; aqui ele vira PCM16 dentro de um WAV (`ulawParaWav`),
 * porque navegador não toca μ-law cru. Sem custo na ElevenLabs. A prévia (ainda
 * não salva) é outra peça: `OuvirPrevia`, que toca o áudio que já está na aba.
 *
 * Baixa SÓ quando a pessoa pede ("Ouvir"): abrir a aba Voz e falas (ou a lista de
 * menus) não puxa o áudio de todas as falas do Storage, que no self-host é cota
 * paga. Depois de baixado, o `<audio>` fica na tela e tocar de novo não vai à rede.
 *
 * Por `fetch`, e não pelo `apiClient`: a resposta é binária (`audio/basic`), e o
 * `apiClient` lê o corpo como texto/JSON. Continua sendo a NOSSA rota, com o
 * cookie da sessão — nunca o Storage direto (bucket privado) nem o cliente do
 * Supabase no navegador. Na recusa, a frase é a da rota: "o áudio sumiu, gere a
 * prévia de novo" (404) pede uma ação, "o Storage falhou" (502) só paciência.
 */
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { ulawParaWav } from "@/lib/telefonia/ulaw";
import { Play } from "@/lib/ui/icons";

/** O áudio tem até 2 MB; passado disto, a tela desiste e deixa tentar de novo. */
const PRAZO_DO_AUDIO_MS = 30_000;

type Estado =
  | { falaId: string; fase: "carregando" }
  | { falaId: string; fase: "pronto"; url: string }
  | { falaId: string; fase: "erro"; frase: string | null };

/** A recusa da rota, com a frase dela (já traduzida pelo servidor), quando veio uma. */
class FalhaDoAudio extends Error {
  constructor(readonly frase: string | null) {
    super("falha_do_audio");
  }
}

async function fraseDaRecusa(r: Response): Promise<string | null> {
  const corpo: unknown = await r.json().catch(() => null);
  const mensagem = (corpo as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof mensagem === "string" && mensagem.trim() ? mensagem : null;
}

async function baixarAudio(falaId: string): Promise<Uint8Array> {
  const prazo = new AbortController();
  const relogio = setTimeout(() => prazo.abort(), PRAZO_DO_AUDIO_MS);
  try {
    const r = await fetch(`/api/v1/telefonia/falas/${encodeURIComponent(falaId)}/audio`, {
      credentials: "same-origin",
      signal: prazo.signal,
    });
    if (!r.ok) throw new FalhaDoAudio(await fraseDaRecusa(r));
    return new Uint8Array(await r.arrayBuffer());
  } finally {
    clearTimeout(relogio);
  }
}

export function OuvirFala({ falaId }: { falaId: string }) {
  const t = useT();
  const [estado, setEstado] = useState<Estado | null>(null);
  // O estado é de UMA fala: trocou o id (salvou-se outra), volta ao botão.
  const atual = estado?.falaId === falaId ? estado : null;
  const criadas = useRef<string[]>([]);

  useEffect(() => {
    const lista = criadas.current;
    return () => lista.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const ouvir = () => {
    const id = falaId;
    setEstado({ falaId: id, fase: "carregando" });
    baixarAudio(id)
      .then((ulaw) => {
        const url = URL.createObjectURL(new Blob([ulawParaWav(ulaw)], { type: "audio/wav" }));
        criadas.current.push(url);
        setEstado({ falaId: id, fase: "pronto", url });
      })
      .catch((e: unknown) => {
        setEstado({ falaId: id, fase: "erro", frase: e instanceof FalhaDoAudio ? e.frase : null });
      });
  };

  if (atual?.fase === "pronto") {
    return <audio controls autoPlay src={atual.url} data-fala-audio={falaId} className="h-8 max-w-full" />;
  }
  const carregando = atual?.fase === "carregando";
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={ouvir} disabled={carregando}>
        <Play size={14} aria-hidden /> {carregando ? t("Carregando o áudio…") : t("Ouvir")}
      </Button>
      {atual?.fase === "erro" ? (
        <span className="text-xs text-destructive">
          {atual.frase ? t(atual.frase) : t("Não foi possível carregar o áudio desta fala.")}
        </span>
      ) : null}
    </span>
  );
}
