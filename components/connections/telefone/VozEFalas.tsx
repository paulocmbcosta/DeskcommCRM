"use client";
/**
 * Conexões › Telefone › Voz e falas (desenho da fase 2, §4 e §6.2).
 *
 * A voz das falas e as três falas gerais da organização — aguarde, ninguém
 * atendeu e fora do horário. O fluxo de cada fala é o do dono (D15): "Gerar
 * prévia" (a ÚNICA hora em que a ElevenLabs trabalha; o mesmo texto com a mesma
 * voz não é pago de novo), "Ouvir" aqui mesmo, e "Salvar e usar" — só então as
 * ligações passam a tocar o áudio novo. Sem a chave da ElevenLabs nada é gerado,
 * e a tela diz onde cadastrar. O "fora do horário" sugerido já traz o WhatsApp
 * conectado da organização, quando houver (desenho §4), e segue editável.
 *
 * O ESTADO de cada fala está sempre à vista (`EstadoDaFala`): ainda não gerada,
 * prévia não salva, em uso, em uso com a voz anterior, ou falhou com o motivo. A
 * recusa do "Salvar e usar" aparece no próprio cartão, com a frase da rota — e,
 * quando a prévia não serve mais (`previa_ausente`, `previa_desatualizada`), a
 * prévia sai da tela: o botão volta a pedir "Gerar prévia", que é o que a frase
 * manda fazer.
 *
 * Um gesto por vez em cada fala: enquanto salva, "Gerar prévia" e o campo ficam
 * travados (uma prévia paga no meio do salvar seria apagada por ele, e o texto
 * digitado também); enquanto a prévia é gerada, o "Salvar e usar" fica travado.
 */
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { OuvirFala } from "@/components/telefonia/OuvirFala";
import { OuvirPrevia } from "@/components/telefonia/OuvirPrevia";
import {
  falaParaSalvar,
  fraseDaFalhaDaFala,
  mensagemDaFalhaDaPrevia,
  usePreviaDaFala,
} from "@/components/telefonia/usePreviaDaFala";
import { ehChatDoSite, useChannelSessions, type ChannelSession } from "@/hooks/channels/useChannelSessions";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { TEXTO_SUGERIDO, textoSugeridoForaDoHorario } from "@/lib/telefonia/texto-do-menu";
import {
  FALAS_GERAIS,
  TAMANHO_MAXIMO_DA_FALA,
  type FalaGeral,
  type FalaParaSalvar,
  type FalaPublica,
  type FalhaDaFala,
} from "@/lib/telefonia/vocabulario";
import { Play } from "@/lib/ui/icons";

import { CHAVE_DA_VOZ, useVozDoTelefone, useVozesDaConta, type RespostaDaFala } from "./api";
import { EstadoDaFala } from "./EstadoDaFala";
import { TelefoniaDesligada } from "./TelefoniaDesligada";

const TITULO: Record<FalaGeral, string> = {
  waiting: "Aguarde",
  nobody: "Ninguém atendeu",
  after_hours: "Fora do horário",
};

const QUANDO_TOCA: Record<FalaGeral, string> = {
  waiting: "Toca quando o cliente precisa esperar na fila, e de novo a cada 40 segundos, entre a música.",
  nobody: "Toca antes de desligar, quando ninguém do time atendeu a tempo.",
  after_hours: "Toca quando o time está fora do horário, e a ligação é encerrada em seguida.",
};

/**
 * As recusas do "Salvar e usar" que dizem que ESTA prévia não serve mais — o
 * áudio dela sumiu do Storage, ou o texto/voz mudou depois dela. A frase da rota
 * manda gerar de novo; manter a prévia na tela deixaria o botão "Salvar e usar"
 * convidando a repetir a mesma recusa.
 */
const RECUSA_QUE_PEDE_PREVIA_NOVA: ReadonlySet<FalhaDaFala> = new Set<FalhaDaFala>([
  "previa_ausente",
  "previa_desatualizada",
]);

/**
 * O primeiro WhatsApp conectado da organização, pela mesma lista que o Inbox e a
 * barra lateral usam (`GET /api/v1/channel-sessions`). O chat do site não tem
 * número para dizer ao telefone.
 */
function whatsAppConectado(canais: ChannelSession[] | undefined): string | null {
  return (canais ?? []).find((c) => !ehChatDoSite(c) && c.status === "WORKING" && c.phone_number)?.phone_number ?? null;
}

export function VozEFalas() {
  const t = useT();
  const qc = useQueryClient();
  const consulta = useVozDoTelefone();
  const dados = consulta.data;
  const temChave = Boolean(dados?.oferecida && dados.chave.cadastrada);
  const vozes = useVozesDaConta(temChave);
  const canais = useChannelSessions().data;

  const salvarVoz = useMutation({
    mutationFn: (voice_id: string) => apiClient.put("/api/v1/telefonia/voz", { voice_id }),
    onSuccess: async () => {
      toast.success(t("Voz salva. Gere a prévia e salve cada fala de novo para usar a voz nova."));
      await qc.invalidateQueries({ queryKey: CHAVE_DA_VOZ });
    },
    onError: (e) => showApiError(e),
  });

  if (consulta.isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (consulta.isError || !dados) {
    return (
      <Card className="p-5 text-sm text-muted-foreground">
        {t("Não foi possível carregar a voz do telefone. Recarregue a página.")}
      </Card>
    );
  }
  if (!dados.oferecida) return <TelefoniaDesligada />;

  if (!temChave) {
    return (
      <Card className="space-y-3 p-5" data-telefonia-sem-chave>
        <h2 className="text-base font-semibold">{t("Falta a chave da ElevenLabs")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "As falas do telefone (menu, aguarde, fora do horário e aviso de instabilidade) são geradas pela ElevenLabs, com a chave da sua conta. Sem a chave, nenhuma fala é gerada e nenhum menu pode ser ligado a um número.",
          )}
        </p>
        <Button asChild variant="outline">
          <Link href="/app/ai/credentials">{t("Cadastrar a chave em Credenciais de IA")}</Link>
        </Button>
      </Card>
    );
  }

  const vozAtual = dados.voz?.voice_id ?? null;
  const amostra = (vozes.data ?? []).find((v) => v.voice_id === vozAtual)?.amostra_url ?? null;
  const sugerido = (tipo: FalaGeral) =>
    tipo === "after_hours" ? textoSugeridoForaDoHorario(whatsAppConectado(canais), t) : t(TEXTO_SUGERIDO[tipo]);

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-5">
        <h2 className="text-base font-semibold">{t("Voz das falas")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "A mesma voz vale para todas as falas desta organização. Trocar a voz não muda as falas em uso: gere a prévia e salve cada uma de novo.",
          )}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[16rem] flex-1 space-y-1.5">
            <Label htmlFor="tel-voz">{t("Voz")}</Label>
            <Select
              value={vozAtual ?? ""}
              onValueChange={(v) => salvarVoz.mutate(v)}
              disabled={salvarVoz.isPending || vozes.isLoading}
            >
              <SelectTrigger id="tel-voz">
                <SelectValue placeholder={vozes.isLoading ? t("Carregando…") : t("Escolha uma voz")} />
              </SelectTrigger>
              <SelectContent>
                {(vozes.data ?? []).map((v) => (
                  <SelectItem key={v.voice_id} value={v.voice_id}>
                    {v.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={!amostra}
            onClick={() => {
              if (amostra) void new Audio(amostra).play().catch(() => undefined);
            }}
          >
            <Play size={16} aria-hidden /> {t("Ouvir amostra")}
          </Button>
        </div>
        {vozes.isError ? (
          <p className="text-sm text-destructive">
            {/* A frase da rota: "a ElevenLabs não respondeu" não pede para conferir a chave. */}
            {fraseDaFalhaDaFala(vozes.error, t) ??
              t("Não foi possível listar as vozes da sua conta da ElevenLabs. Tente de novo em instantes.")}
          </p>
        ) : null}
      </Card>

      {FALAS_GERAIS.map((tipo) => (
        <CartaoDaFalaGeral key={tipo} tipo={tipo} fala={dados.falas[tipo]} vozAtual={vozAtual} sugerido={sugerido(tipo)} />
      ))}
    </div>
  );
}

function CartaoDaFalaGeral({
  tipo,
  fala,
  vozAtual,
  sugerido,
}: {
  tipo: FalaGeral;
  fala: FalaPublica | null;
  vozAtual: string | null;
  sugerido: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  // `null` = a pessoa não mexeu no campo: vale o texto da fala em uso, ou o sugerido
  // (que pode chegar depois — o WhatsApp da organização vem de outra consulta).
  const [editado, setEditado] = useState<string | null>(null);
  const texto = editado ?? fala?.texto ?? sugerido;
  // A prévia fica amarrada à voz com que foi pedida (o hash dela inclui a voz):
  // trocada a voz, some, e a tela volta a pedir "Gerar prévia" em vez de oferecer
  // um salvar que o servidor recusaria com `previa_desatualizada`.
  const previa = usePreviaDaFala(vozAtual);
  const previaDoCampo = previa.valePara(texto);
  const paraSalvar = falaParaSalvar(texto, fala, previa.previa);
  // Há o que salvar quando a prévia deste texto não é a fala em uso — ou quando a
  // pessoa acabou de gerar a prévia do MESMO texto em uso: é o conserto de um
  // áudio que sumiu do Storage ("gere a prévia de novo e salve", diz a rota do
  // áudio), e salvar a mesma fala não escreve nem audita nada no servidor.
  const podeSalvar = paraSalvar !== null && (paraSalvar.hash !== fala?.hash || previaDoCampo);
  const previaNaoSalva = paraSalvar !== null && paraSalvar.hash !== fala?.hash;
  const emUsoNoCampo = fala?.status === "ready" && fala.texto === texto.trim();

  const salvar = useMutation({
    mutationFn: async (p: FalaParaSalvar) =>
      (await apiClient.put<{ data: RespostaDaFala }>(`/api/v1/telefonia/falas/gerais/${tipo}`, p)).data,
    // Nas opções, e aguardado: o salvar só termina (e o campo só destrava) depois
    // de a aba reler a voz — senão o campo voltaria editável por um instante com o
    // texto antigo, e o que a pessoa digitasse ali seria apagado logo em seguida.
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE_DA_VOZ }),
  });
  const salvarFala = (p: FalaParaSalvar) =>
    // Os efeitos na TELA vão no `mutate`: não rodam depois de um `reset()`.
    salvar.mutate(p, {
      onSuccess: () => {
        previa.limpar();
        setEditado(null);
        toast.success(t("Fala salva. As ligações já tocam o áudio novo."));
      },
      onError: (e) => {
        if (e instanceof ApiError && RECUSA_QUE_PEDE_PREVIA_NOVA.has(e.code as FalhaDaFala)) previa.limpar();
      },
    });
  const falhaAoSalvar = salvar.isError
    ? (fraseDaFalhaDaFala(salvar.error, t) ?? t("Não foi possível salvar a fala. Tente de novo em instantes."))
    : null;

  const idDoCampo = `tel-fala-${tipo}`;
  const nome = t(TITULO[tipo]);

  return (
    <Card className="space-y-3 p-5" data-fala-geral={tipo}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{nome}</h3>
        <EstadoDaFala
          fala={fala}
          vozAtual={vozAtual}
          gerando={previa.gerando}
          previaNaoSalva={previaNaoSalva}
          erro={mensagemDaFalhaDaPrevia(previa.erroPara(texto), t)}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t(QUANDO_TOCA[tipo])}</p>
      <Label htmlFor={idDoCampo} className="sr-only">
        {t("Texto da fala: {fala}").replace("{fala}", nome)}
      </Label>
      <Textarea
        id={idDoCampo}
        rows={3}
        maxLength={TAMANHO_MAXIMO_DA_FALA}
        value={texto}
        disabled={salvar.isPending}
        onChange={(e) => {
          setEditado(e.target.value);
          if (salvar.isError) salvar.reset();
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          data-gerar-previa={tipo}
          onClick={() => {
            salvar.reset();
            previa.gerar(texto);
          }}
          disabled={!vozAtual || !texto.trim() || previa.gerando || salvar.isPending}
        >
          <Play size={16} aria-hidden /> {previa.gerando ? t("Gerando a prévia…") : t("Gerar prévia")}
        </Button>
        <Button
          type="button"
          onClick={() => {
            if (paraSalvar && podeSalvar) salvarFala(paraSalvar);
          }}
          disabled={!podeSalvar || salvar.isPending || previa.gerando}
        >
          {salvar.isPending ? t("Salvando…") : t("Salvar e usar")}
        </Button>
        {!vozAtual ? <span className="text-xs text-muted-foreground">{t("Escolha a voz acima antes de gerar.")}</span> : null}
      </div>
      {previaDoCampo && previa.previa ? (
        <OuvirPrevia audio={previa.previa.audio} aoOuvir={previa.marcarOuvida} nome={nome} />
      ) : emUsoNoCampo && fala ? (
        <OuvirFala falaId={fala.id} nome={nome} />
      ) : null}
      {vozAtual && !emUsoNoCampo && paraSalvar === null && texto.trim() && !previa.gerando ? (
        <p className="text-xs text-muted-foreground">{t("Gere a prévia deste texto e ouça antes de salvar.")}</p>
      ) : null}
      {falhaAoSalvar ? (
        <p role="alert" className="text-sm text-destructive">
          {falhaAoSalvar}
        </p>
      ) : null}
    </Card>
  );
}
