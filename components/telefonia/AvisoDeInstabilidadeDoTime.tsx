"use client";
/**
 * O cartão "Aviso de instabilidade (telefone)" de cada time, em Configurações ›
 * Times (desenho da fase 2, D7/D8 e §6.3).
 *
 * Desligado: o texto guardado e "Ligar aviso", que abre a janela com o texto
 * editável, "Gerar prévia", "Ouvir", a duração (2 h por padrão) e "Ligar". Com o
 * texto mudado, "Ligar" só destrava depois de gerar a prévia E ouvir (§6.3) e
 * manda o hash dela; com o texto já gravado, liga direto com o hash dele — ele foi
 * ouvido quando foi gravado. Ligar não chama a ElevenLabs: a rota confere o hash.
 * Ligado: quando, por quem e até quando (hora de quem olha), e "Desligar agora".
 *
 * Os botões seguem `pode_mudar` da leitura — a régua da sessão decidida no
 * servidor, a mesma das escritas (`useAvisosDosTimes`). Só aparece onde a
 * instalação oferece telefonia e para quem recebe a lista dos times.
 *
 * O gerente não lê a voz do telefone (a rota da voz é de admin): a prévia fica
 * amarrada a "nenhuma voz conhecida" (`usePreviaDaFala(null)`). Se a voz mudou
 * depois da prévia, quem recusa é a rota (`previa_desatualizada`), e a janela
 * tira a prévia da tela para pedir outra.
 *
 * Recusas aparecem com a frase da rota (`fraseDaFalhaDaFala`) ao lado do botão —
 * nunca a mensagem crua de uma resposta sem corpo (o HTML de um proxy).
 */
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { ApiError } from "@/lib/api/types";
import { TEXTO_SUGERIDO } from "@/lib/telefonia/texto-do-menu";
import { DURACAO_PADRAO, type DuracaoDaEmergencia } from "@/lib/telefonia/vencimento-da-emergencia";
import { TAMANHO_MAXIMO_DA_FALA, type AvisoDoTimePublico } from "@/lib/telefonia/vocabulario";
import { Play, Siren } from "@/lib/ui/icons";

import { OuvirFala } from "./OuvirFala";
import { OuvirPrevia } from "./OuvirPrevia";
import { horaDoAviso, useAvisosDosTimes, useDesligarAviso, useLigarAviso } from "./useAvisosDeInstabilidade";
import { falaParaSalvar, fraseDaFalhaDaFala, mensagemDaFalhaDaPrevia, usePreviaDaFala } from "./usePreviaDaFala";

/** As recusas do "Ligar" que dizem que a prévia da tela não serve mais: é preciso gerar outra. */
const PREVIA_QUE_NAO_SERVE = new Set(["previa_ausente", "previa_desatualizada"]);

export function AvisoDeInstabilidadeDoTime({ teamId }: { teamId: string }) {
  const t = useT();
  const locale = useLocaleDeData();
  const avisos = useAvisosDosTimes();
  const desligar = useDesligarAviso();
  const [aberto, setAberto] = useState(false);

  // Só a PRIMEIRA leitura que falha vira a mensagem: com um estado já na tela, a
  // releitura que falha o mantém (a próxima, de 60 s, confere de novo) em vez de
  // trocar o cartão inteiro por um erro.
  if (avisos.isError && !avisos.data) {
    return (
      <Card className="p-4 text-sm text-muted-foreground" data-aviso-de-instabilidade={teamId} data-falha-da-leitura="">
        {t("Não foi possível carregar o aviso de instabilidade do telefone. Recarregue a página.")}
      </Card>
    );
  }
  const dados = avisos.data;
  if (!dados?.oferecida || !dados.times) return null;
  const aviso = dados.times.find((a) => a.team_id === teamId);
  if (!aviso) return null;

  const agora = new Date();
  const hora = (iso: string) => horaDoAviso(iso, agora, locale);
  const gravada = aviso.fala?.status === "ready" ? aviso.fala : null;
  const desligando = desligar.isPending && desligar.variables === teamId;

  return (
    <Card className="space-y-2 p-4" data-aviso-de-instabilidade={teamId} data-ativo={aviso.ativa ? "sim" : "nao"}>
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Siren size={16} aria-hidden /> {t("Aviso de instabilidade (telefone)")}
      </h3>
      {aviso.ativa ? (
        <p className="text-sm font-medium">
          {aviso.desde
            ? aviso.ligada_por
              ? t("Ligado às {hora} por {nome}").replace("{hora}", hora(aviso.desde)).replace("{nome}", aviso.ligada_por)
              : t("Ligado às {hora}").replace("{hora}", hora(aviso.desde))
            : null}
          {" · "}
          {aviso.expira_em ? t("desliga às {hora}").replace("{hora}", hora(aviso.expira_em)) : t("até alguém desligar")}
        </p>
      ) : null}
      {gravada ? (
        <div className="flex flex-wrap items-center gap-2">
          <q className="text-sm text-muted-foreground">{gravada.texto}</q>
          <OuvirFala
            falaId={gravada.id}
            nome={t("Aviso de instabilidade do time {time}").replace("{time}", aviso.time_nome)}
          />
        </div>
      ) : aviso.ativa ? null : (
        <p className="text-sm text-muted-foreground">
          {t(
            "Nenhum aviso gravado ainda. Toda ligação de fora que entrar na fila deste time ouve o aviso inteiro antes de tocar nos atendentes.",
          )}
        </p>
      )}
      {dados.pode_mudar ? (
        aviso.ativa ? (
          <Button type="button" variant="outline" onClick={() => desligar.mutate(teamId)} disabled={desligar.isPending}>
            {desligando ? t("Desligando…") : t("Desligar agora")}
          </Button>
        ) : (
          <Button type="button" onClick={() => setAberto(true)}>
            {t("Ligar aviso")}
          </Button>
        )
      ) : null}
      {aberto && dados.pode_mudar ? <JanelaDoAviso aviso={aviso} aoFechar={() => setAberto(false)} /> : null}
    </Card>
  );
}

/** Onde a janela está no caminho até o "Ligar" — dito na tela, e em `data-passo-do-aviso`. */
type Passo = "gravado" | "falta-previa" | "falta-ouvir" | "pronto";

function JanelaDoAviso({ aviso, aoFechar }: { aviso: AvisoDoTimePublico; aoFechar: () => void }) {
  const t = useT();
  const emUso = aviso.fala?.status === "ready" ? aviso.fala : null;
  const [texto, setTexto] = useState(() => emUso?.texto ?? t(TEXTO_SUGERIDO.emergency));
  const [duracao, setDuracao] = useState<DuracaoDaEmergencia>(DURACAO_PADRAO);
  const previa = usePreviaDaFala(null);
  // A janela ainda está na tela? Enquanto estiver, a recusa do "Ligar" aparece
  // aqui; se ela sair antes da resposta, o hook avisa por toast (`useLigarAviso`).
  const aberta = useRef(true);
  useEffect(() => {
    aberta.current = true;
    return () => {
      aberta.current = false;
    };
  }, []);
  const ligar = useLigarAviso(aberta);

  // §6.3: com o texto mudado, "Ligar" exige "Gerar prévia" E "Ouvir". Com o texto do
  // aviso já gravado, liga direto — ele foi ouvido quando foi gravado.
  const textoGravado = emUso !== null && emUso.texto === texto.trim();
  const previaDoTexto = previa.previa !== null && previa.valePara(texto);
  const fala = falaParaSalvar(texto, emUso, previa.previa);
  const podeLigar = fala !== null && (textoGravado || (previaDoTexto && previa.ouvida));
  const passo: Passo = textoGravado ? "gravado" : !previaDoTexto ? "falta-previa" : !previa.ouvida ? "falta-ouvir" : "pronto";
  const falhaDaPrevia = mensagemDaFalhaDaPrevia(previa.erroPara(texto), t);
  const falhaDoLigar = ligar.error
    ? (fraseDaFalhaDaFala(ligar.error, t) ?? t("Não foi possível ligar o aviso. Tente de novo em instantes."))
    : null;

  const ligarAgora = () => {
    if (!fala || !podeLigar) return;
    ligar.mutate(
      { teamId: aviso.team_id, fala, duracao },
      {
        onSuccess: aoFechar,
        onError: (e) => {
          if (e instanceof ApiError && PREVIA_QUE_NAO_SERVE.has(e.code)) previa.limpar();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        // Enquanto liga, nem Esc, nem o X, nem o clique fora fecham: a resposta
        // (ou a recusa) tem de chegar a quem pediu.
        if (!v && !ligar.isPending) aoFechar();
      }}
    >
      <DialogContent data-janela-do-aviso="">
        <DialogHeader>
          <DialogTitle>{t("Ligar o aviso de instabilidade")}</DialogTitle>
          <DialogDescription>
            {t(
              "Toda ligação de fora que entrar na fila do time ouve este aviso inteiro antes de tocar nos atendentes. A ligação transferida por um atendente não ouve.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="aviso-texto">{t("Texto do aviso")}</Label>
          <Textarea
            id="aviso-texto"
            rows={4}
            maxLength={TAMANHO_MAXIMO_DA_FALA}
            value={texto}
            disabled={ligar.isPending}
            onChange={(e) => {
              setTexto(e.target.value);
              ligar.reset();
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-gerar-previa="emergency"
            disabled={!texto.trim() || previa.gerando || ligar.isPending}
            onClick={() => {
              ligar.reset();
              previa.gerar(texto);
            }}
          >
            <Play size={14} aria-hidden /> {previa.gerando ? t("Gerando a prévia…") : t("Gerar prévia")}
          </Button>
          {/* Um tocador só na janela: o nome acessível é o do botão, "Ouvir". */}
          {previa.previa && previaDoTexto ? (
            <OuvirPrevia audio={previa.previa.audio} aoOuvir={previa.marcarOuvida} />
          ) : textoGravado && emUso ? (
            <OuvirFala falaId={emUso.id} />
          ) : null}
        </div>
        <p aria-live="polite" data-passo-do-aviso={passo} className="text-xs text-muted-foreground">
          {passo === "gravado"
            ? t("Este é o texto já gravado do aviso: dá para ligar direto.")
            : passo === "falta-previa"
              ? t("Gere a prévia e ouça o aviso antes de ligar.")
              : passo === "falta-ouvir"
                ? t("Ouça a prévia antes de ligar.")
                : t("Prévia ouvida. Pode ligar.")}
        </p>
        {falhaDaPrevia ? (
          <p role="alert" data-falha-da-previa="" className="text-sm text-destructive">
            {falhaDaPrevia}
          </p>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="aviso-duracao">{t("Desligar sozinho depois de")}</Label>
          <Select value={duracao} onValueChange={(v) => setDuracao(v as DuracaoDaEmergencia)} disabled={ligar.isPending}>
            <SelectTrigger id="aviso-duracao">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">{t("1 hora")}</SelectItem>
              <SelectItem value="2h">{t("2 horas (padrão)")}</SelectItem>
              <SelectItem value="4h">{t("4 horas")}</SelectItem>
              <SelectItem value="indefinida">{t("Até eu desligar")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {falhaDoLigar ? (
          <p role="alert" data-falha-do-ligar="" className="text-sm text-destructive">
            {falhaDoLigar}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={aoFechar} disabled={ligar.isPending}>
            {t("Cancelar")}
          </Button>
          <Button type="button" onClick={ligarAgora} disabled={!podeLigar || previa.gerando || ligar.isPending}>
            {ligar.isPending ? t("Ligando…") : t("Ligar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
