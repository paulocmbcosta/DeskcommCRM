"use client";
/**
 * O selo de uma fala (desenho da fase 2, §6.2): gerando a prévia, falhou (com o
 * motivo traduzido — "falhou" sem porquê não diz o que fazer), prévia não salva
 * (as ligações ainda tocam a anterior), ainda não gerada, em uso com a voz
 * anterior (trocou-se a voz e ninguém salvou de novo) ou em uso.
 *
 * `data-estado-da-fala` diz o estado sem depender do texto, que muda com o idioma.
 */
import { Badge } from "@/components/ui/badge";
import { useT } from "@/hooks/i18n/useT";
import { MENSAGEM_DA_FALHA_DA_FALA, ehFalhaDaFala, type FalaPublica } from "@/lib/telefonia/vocabulario";

/** A falha é longa ("Muitas prévias geradas na última hora…"): o selo quebra linha em vez de vazar. */
const SELO_DA_FALHA = "h-auto max-w-full whitespace-normal text-left";

export function EstadoDaFala({
  fala,
  vozAtual,
  gerando = false,
  previaNaoSalva = false,
  erro = null,
}: {
  /** A fala EM USO (a que as ligações tocam), ou `null`. */
  fala: FalaPublica | null;
  vozAtual: string | null;
  /** A prévia está sendo gerada agora. */
  gerando?: boolean;
  /** Há uma prévia deste texto que ainda não foi salva. */
  previaNaoSalva?: boolean;
  /** A falha da última prévia, já traduzida. */
  erro?: string | null;
}) {
  const t = useT();
  if (gerando) {
    return (
      <Badge variant="secondary" data-estado-da-fala="gerando">
        {t("Gerando a prévia…")}
      </Badge>
    );
  }
  if (erro) {
    return (
      <Badge variant="destructive" role="alert" className={SELO_DA_FALHA} data-estado-da-fala="falhou">
        {t("Falhou:")} {erro}
      </Badge>
    );
  }
  if (previaNaoSalva) {
    return (
      <Badge variant="secondary" data-estado-da-fala="previa">
        {t("Prévia não salva")}
      </Badge>
    );
  }
  if (!fala) {
    return (
      <Badge variant="outline" data-estado-da-fala="ausente">
        {t("Ainda não gerada")}
      </Badge>
    );
  }
  if (fala.status === "failed") {
    // Um código que o vocabulário não conhece (legado de um clone) não aparece cru.
    const motivo = t(MENSAGEM_DA_FALHA_DA_FALA[ehFalhaDaFala(fala.erro) ? fala.erro : "erro_do_provedor"]);
    return (
      <Badge variant="destructive" className={SELO_DA_FALHA} data-estado-da-fala="falhou">
        {t("Falhou:")} {motivo}
      </Badge>
    );
  }
  if (vozAtual && fala.voice_id !== vozAtual) {
    return (
      <Badge variant="outline" data-estado-da-fala="outra-voz">
        {t("Em uso, com a voz anterior")}
      </Badge>
    );
  }
  return (
    <Badge className="bg-emerald-600 text-white hover:bg-emerald-600" data-estado-da-fala="em-uso">
      {t("Em uso")}
    </Badge>
  );
}
