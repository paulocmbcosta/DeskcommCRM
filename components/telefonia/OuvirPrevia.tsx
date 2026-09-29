"use client";
/**
 * Toca a PRÉVIA de uma fala, que está só na memória da aba (o μ-law que a rota da
 * prévia devolveu, convertido em WAV por `ulawParaWav`: navegador não toca μ-law
 * cru). Ouvir de novo não vai à rede e não custa nada. `aoOuvir` avisa quem
 * precisa saber que a pessoa ouviu — o botão "Ouvir" e o play do próprio
 * `<audio>` contam: o aviso de instabilidade só liga depois disso (desenho §6.3).
 *
 * O endereço `blob:` nasce e morre no mesmo efeito, e vai ao `<audio>` pela ref:
 * cada áudio novo (ou a remontagem do modo estrito) tem o seu, e nenhum sobra.
 */
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { ulawParaWav } from "@/lib/telefonia/ulaw";
import { Play } from "@/lib/ui/icons";

export function OuvirPrevia({ audio, aoOuvir }: { audio: Uint8Array; aoOuvir?: () => void }) {
  const t = useT();
  const el = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const url = URL.createObjectURL(new Blob([ulawParaWav(audio)], { type: "audio/wav" }));
    if (el.current) el.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [audio]);

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          aoOuvir?.();
          void Promise.resolve(el.current?.play()).catch(() => undefined);
        }}
      >
        <Play size={14} aria-hidden /> {t("Ouvir")}
      </Button>
      <audio ref={el} controls data-previa-audio onPlay={() => aoOuvir?.()} className="h-8 max-w-full" />
    </span>
  );
}
