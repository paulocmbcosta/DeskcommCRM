"use client";
/**
 * "Gerar prévia" de UMA fala do editor de menu (a do menu, ou a de tecla
 * inválida), o estado dela e o que dá para ouvir: a prévia deste texto, ou a
 * fala em uso quando o texto é o dela.
 *
 * `emUso` é a fala em uso que AINDA VALE: depois de a rota dizer que o áudio dela
 * sumiu do Storage (`previa_ausente`), o editor passa `null` — o selo deixa de
 * dizer "Em uso" e o tocador não aponta para um áudio que não existe mais.
 */
import { OuvirFala } from "@/components/telefonia/OuvirFala";
import { OuvirPrevia } from "@/components/telefonia/OuvirPrevia";
import { mensagemDaFalhaDaPrevia, type usePreviaDaFala } from "@/components/telefonia/usePreviaDaFala";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import type { FalaParaSalvar, FalaPublica } from "@/lib/telefonia/vocabulario";
import { Play } from "@/lib/ui/icons";

import { EstadoDaFala } from "./EstadoDaFala";

export function PreviaDoCampo({
  qual,
  nome,
  texto,
  emUso,
  paraSalvar,
  previa,
  vozAtual,
  travado,
  aoGerar,
}: {
  /** O tipo da fala (`phone_prompts.kind`), para o seletor `data-gerar-previa`. */
  qual: "menu" | "invalid";
  /** O nome da fala, para o leitor de tela distinguir os tocadores. */
  nome: string;
  texto: string;
  /** A fala EM USO que ainda vale (`null` sem fala, ou depois de o áudio dela sumir). */
  emUso: FalaPublica | null;
  /** O que o "Salvar menu" mandaria por esta fala agora (`null` = falta a prévia). */
  paraSalvar: FalaParaSalvar | null;
  previa: ReturnType<typeof usePreviaDaFala>;
  vozAtual: string | null;
  /** O salvar está em andamento: nada de pagar uma prévia no meio dele. */
  travado: boolean;
  aoGerar: () => void;
}) {
  const t = useT();
  const emUsoNoCampo = emUso?.status === "ready" && emUso.texto === texto.trim();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-gerar-previa={qual}
        onClick={aoGerar}
        disabled={!vozAtual || !texto.trim() || previa.gerando || travado}
      >
        <Play size={14} aria-hidden /> {previa.gerando ? t("Gerando a prévia…") : t("Gerar prévia")}
      </Button>
      <EstadoDaFala
        fala={emUso}
        vozAtual={vozAtual}
        gerando={previa.gerando}
        previaNaoSalva={paraSalvar !== null && paraSalvar.hash !== emUso?.hash}
        erro={mensagemDaFalhaDaPrevia(previa.erroPara(texto), t)}
      />
      {previa.previa && previa.valePara(texto) ? (
        <OuvirPrevia audio={previa.previa.audio} aoOuvir={previa.marcarOuvida} nome={nome} />
      ) : emUsoNoCampo && emUso ? (
        <OuvirFala falaId={emUso.id} nome={nome} />
      ) : null}
    </div>
  );
}
