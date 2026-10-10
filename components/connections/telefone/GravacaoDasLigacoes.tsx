"use client";
/**
 * Conexões › Telefone › Gravação (F3 da spec 20; desenho
 * docs/superpowers/specs/2026-09-29-telefonia-gravacao-das-ligacoes-design.md).
 *
 * A política da organização: gravar ou não as ligações, e por quanto tempo
 * guardar. O que é gravado (só a conversa, depois de o atendente atender), quem
 * ouve (atendente ou acima que enxerga a conversa, com cada escuta auditada) e
 * quanto ocupa ficam escritos aqui, para quem liga saber o que está ligando.
 *
 * O AVISO DE GRAVAÇÃO manda: sem ele pronto (a fala geral gerada em Voz e
 * falas), o interruptor não liga — e a rota recusa do mesmo jeito (409), porque
 * a regra é do servidor e a tela só a espelha. Desligar e mudar a retenção nunca
 * dependem do aviso.
 *
 * A TRANSCRIÇÃO (F4): um segundo interruptor, desligado por padrão. Só liga com
 * a gravação ligada (não há o que transcrever sem ela) e com uma chave da OpenAI
 * cadastrada — a rota recusa do mesmo jeito (409). Desligar nunca depende de
 * nada. A tela diz o que quem liga precisa saber antes: para onde vão o áudio
 * (a OpenAI) e o texto (o modelo de conversa da organização — que pode ser de
 * outro provedor), que custa e conta no teto de gasto, que vale só daqui para
 * frente e que "quem falou" é estimativa.
 */
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { OuvirFala } from "@/components/telefonia/OuvirFala";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { RETENCAO_PADRAO_DIAS } from "@/lib/telefonia/gravacao";
import { trocarMarcador } from "@/lib/telefonia/texto-do-menu";

import { CHAVE_DA_GRAVACAO, useGravacaoDoTelefone } from "./api";
import { TelefoniaDesligada } from "./TelefoniaDesligada";

/** Onde se gera o aviso: a aba Voz e falas. */
const ABA_DAS_FALAS = "/app/connections?aba=telefone&sub=falas";
/** Onde se cadastra a chave que transcreve. */
const PROVEDORES_DE_IA = "/app/ai/providers";

/** Como a tela diz cada retenção. Os valores vêm da rota; um que falte aqui sai em dias. */
const NOME_DA_RETENCAO: Record<number, string> = {
  30: "30 dias",
  60: "60 dias",
  90: "90 dias",
  180: "180 dias",
  365: "1 ano",
  730: "2 anos",
  1825: "5 anos",
};

export function GravacaoDasLigacoes() {
  const t = useT();
  const qc = useQueryClient();
  const consulta = useGravacaoDoTelefone();
  const dados = consulta.data;
  // `null` = a pessoa não mexeu: vale o que está salvo.
  const [ativa, setAtiva] = useState<boolean | null>(null);
  const [retencao, setRetencao] = useState<number | null>(null);
  const [transcrever, setTranscrever] = useState<boolean | null>(null);

  const salvar = useMutation({
    mutationFn: (p: { ativa: boolean; retencao_dias: number; transcrever: boolean; soATranscricaoMudou: boolean }) =>
      apiClient.put("/api/v1/telefonia/gravacao", { ativa: p.ativa, retencao_dias: p.retencao_dias, transcrever: p.transcrever }),
    onSuccess: async (_r, p) => {
      toast.success(
        p.soATranscricaoMudou
          ? p.transcrever
            ? t("Transcrição ligada. As próximas ligações gravadas serão transcritas.")
            : t("Transcrição desligada. As próximas ligações não serão transcritas.")
          : p.ativa
            ? t("Gravação ligada. As próximas ligações serão gravadas, com o aviso no começo.")
            : t("Gravação desligada. As próximas ligações não serão gravadas."),
      );
      await qc.invalidateQueries({ queryKey: CHAVE_DA_GRAVACAO });
      setAtiva(null);
      setRetencao(null);
      setTranscrever(null);
    },
    onError: (e) => showApiError(e),
  });

  if (consulta.isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (consulta.isError || !dados) {
    return (
      <Card className="p-5 text-sm text-muted-foreground">
        {t("Não foi possível carregar a gravação do telefone. Recarregue a página.")}
      </Card>
    );
  }
  if (!dados.oferecida) return <TelefoniaDesligada />;

  const avisoPronto = dados.aviso?.status === "ready";
  const ativaNaTela = ativa ?? dados.ativa;
  const retencaoNaTela = retencao ?? dados.retencao_dias;
  const transcreverNaTela = transcrever ?? dados.transcrever;
  const gravacaoMudou = ativaNaTela !== dados.ativa || retencaoNaTela !== dados.retencao_dias;
  const transcricaoMudou = transcreverNaTela !== dados.transcrever;
  const mudou = gravacaoMudou || transcricaoMudou;
  // Ligar pede o aviso pronto; desligar, nunca.
  const podeLigar = avisoPronto || dados.ativa;
  // Ligar a transcrição pede a gravação ligada (na tela) e uma chave; `null` é
  // "não sei" — a tela não afirma que falta, e a rota decide. Desligar, nunca.
  const semChave = dados.transcricao_com_chave === false;
  const podeTranscrever = ativaNaTela && !semChave;
  const nomeDaRetencao = (dias: number) => {
    const nome = NOME_DA_RETENCAO[dias];
    const rotulo = nome ? t(nome) : trocarMarcador(t("{dias} dias"), "{dias}", String(dias));
    return dias === RETENCAO_PADRAO_DIAS ? trocarMarcador(t("{retencao} (recomendado)"), "{retencao}", rotulo) : rotulo;
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-5" data-gravacao-do-telefone={dados.ativa ? "ligada" : "desligada"}>
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t("Gravação das ligações")}</h2>
          <p className="text-sm text-muted-foreground">
            {t(
              "Grava a conversa entre o cliente e o atendente, nas ligações recebidas e nas feitas pelo CRM. O menu e a espera não são gravados. A gravação aparece no cartão da ligação, dentro da conversa.",
            )}
          </p>
        </div>

        <div className="space-y-2 rounded-md border p-3" data-aviso-de-gravacao={avisoPronto ? "pronto" : "ausente"}>
          <p className="text-sm font-medium">{t("Aviso de gravação")}</p>
          {avisoPronto && dados.aviso ? (
            <>
              <p className="text-sm text-muted-foreground">“{dados.aviso.texto}”</p>
              <div className="flex flex-wrap items-center gap-2">
                <OuvirFala falaId={dados.aviso.id} nome={t("Aviso de gravação")} />
                <Button asChild variant="link" className="h-auto px-0">
                  <Link href={ABA_DAS_FALAS}>{t("Mudar o aviso em Voz e falas")}</Link>
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {t(
                  "Quem está na linha precisa ser avisado de que a ligação é gravada (LGPD). Gere e salve o aviso de gravação na aba Voz e falas; sem ele, a gravação não liga.",
                )}
              </p>
              <Button asChild variant="outline" size="sm">
                <Link href={ABA_DAS_FALAS}>{t("Criar o aviso em Voz e falas")}</Link>
              </Button>
            </>
          )}
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="tel-gravar">{t("Gravar as ligações")}</Label>
            <p className="text-xs text-muted-foreground">
              {t(
                "Recebidas: o aviso toca depois do menu, logo antes de chamar o atendente. Feitas pelo atendente: o aviso toca quando o cliente atende. Se o aviso não tocar, aquela ligação não é gravada.",
              )}
            </p>
          </div>
          <Switch
            id="tel-gravar"
            checked={ativaNaTela}
            disabled={salvar.isPending || (!ativaNaTela && !podeLigar)}
            onCheckedChange={(v) => setAtiva(v)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="tel-retencao">{t("Guardar as gravações por")}</Label>
          <Select
            value={String(retencaoNaTela)}
            onValueChange={(v) => setRetencao(Number(v))}
            disabled={salvar.isPending}
          >
            <SelectTrigger id="tel-retencao" className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dados.retencoes.map((dias) => (
                <SelectItem key={dias} value={String(dias)}>
                  {nomeDaRetencao(dias)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t(
              "Depois desse prazo, a gravação é apagada sozinha. Cada minuto gravado ocupa cerca de 180 KB no armazenamento. Para atendimento ao consumidor (SAC), a lei pede no mínimo 90 dias.",
            )}
          </p>
        </div>

        <div
          className="space-y-2 border-t pt-4"
          data-transcricao-do-telefone={dados.transcrever ? "ligada" : "desligada"}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="tel-transcrever">{t("Transcrever as ligações gravadas")}</Label>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Depois de cada ligação gravada, o sistema escreve o que foi dito e um resumo curto. Os dois aparecem no cartão da ligação, dentro da conversa. Vale para as ligações gravadas daqui para frente: as antigas não são transcritas.",
                )}
              </p>
            </div>
            <Switch
              id="tel-transcrever"
              checked={transcreverNaTela}
              disabled={salvar.isPending || (!transcreverNaTela && !podeTranscrever)}
              onCheckedChange={(v) => setTranscrever(v)}
            />
          </div>
          {semChave ? (
            <p className="text-xs text-muted-foreground" data-transcricao-sem-chave>
              {t("Para transcrever, cadastre antes uma chave da OpenAI.")}{" "}
              <Link href={PROVEDORES_DE_IA} className="underline underline-offset-2">
                {t("Abrir os provedores de IA")}
              </Link>
            </p>
          ) : !ativaNaTela ? (
            <p className="text-xs text-muted-foreground" data-transcricao-sem-gravacao>
              {t("A transcrição depende da gravação: ligue a gravação das ligações para poder transcrever.")}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t(
              "O áudio da ligação é enviado à OpenAI para ser transcrito, e o texto que volta vai ao modelo de IA escolhido em Agente de IA › Provedores, que escreve o resumo e indica quem falou. A OpenAI cobra por minuto de áudio, na conta da chave usada, e os dois gastos contam no teto de gasto de IA. O texto é feito por máquina a partir de áudio de telefone: pode errar nomes, números e endereços, e a indicação de quem falou é uma estimativa.",
            )}
          </p>
        </div>

        <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
          {t(
            "Quem ouve e quem lê a transcrição: atendentes, gestores e administradores que enxergam a conversa. Cada vez que alguém ouve uma gravação ou abre uma transcrição, fica registrado na auditoria. A transcrição é apagada junto com a gravação, no fim do prazo de guarda. Anonimizar um contato apaga as gravações e as transcrições das ligações dele.",
          )}
        </div>

        <div className="flex justify-end">
          <Button
            type="button"
            disabled={!mudou || salvar.isPending}
            onClick={() =>
              salvar.mutate({
                ativa: ativaNaTela,
                retencao_dias: retencaoNaTela,
                // Desligar a gravação com a transcrição ligada: a transcrição fica
                // como estava (sem gravação ela não faz nada, e volta junto).
                transcrever: transcreverNaTela,
                soATranscricaoMudou: transcricaoMudou && !gravacaoMudou,
              })
            }
          >
            {salvar.isPending ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
