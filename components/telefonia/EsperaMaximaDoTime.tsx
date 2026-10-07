"use client";
/**
 * O cartão "Fila do telefone" de cada time, em Configurações › Times (migration
 * 0295): quanto tempo um cliente espera na fila do telefone do time quando
 * ninguém está livre. Trocar o valor grava na hora; o padrão (2 minutos) grava
 * `null`, para o time seguir o padrão do produto se ele mudar.
 *
 * O que aparece é o que VALE (`em_vigor_s`), não só o gravado. Um valor que não
 * está entre as opções — gravado por outro caminho — aparece como opção a mais,
 * em segundos, em vez de o seletor mentir com a opção vizinha.
 *
 * Só aparece onde a instalação oferece telefonia e para o time que veio na
 * leitura (os ativos). Quem já está esperando não muda: o worker lê o teto
 * quando a ligação entra na fila do time.
 */
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { OPCOES_DE_ESPERA_NA_FILA_S } from "@/lib/telefonia/distribuicao";
import { trocarMarcador } from "@/lib/telefonia/texto-do-menu";
import { Phone } from "@/lib/ui/icons";

import { useEsperaDosTimes, useGravarEspera } from "./useEsperaDosTimes";

const OPCOES: readonly number[] = OPCOES_DE_ESPERA_NA_FILA_S;
/** A primeira opção é o padrão do produto: escolhê-la apaga a configuração do time. */
const PADRAO_S = OPCOES_DE_ESPERA_NA_FILA_S[0];

export function EsperaMaximaDoTime({ teamId }: { teamId: string }) {
  const t = useT();
  const espera = useEsperaDosTimes();
  const gravar = useGravarEspera();

  // Só a leitura que falha SEM dado na tela vira a mensagem: com um valor já
  // mostrado, a releitura que falha o mantém.
  if (espera.isError && !espera.data) {
    return (
      <Card className="p-4 text-sm text-muted-foreground" data-espera-da-fila={teamId} data-falha-da-leitura="">
        {t("Não foi possível carregar a espera da fila do telefone. Recarregue a página.")}
      </Card>
    );
  }
  const dados = espera.data;
  if (!dados?.oferecida) return null;
  const time = dados.times.find((x) => x.team_id === teamId);
  if (!time) return null;

  // Enquanto grava, o seletor mostra o que a pessoa escolheu — e não volta ao de antes.
  const escolhido = gravar.isPending ? gravar.variables : null;
  const emVigor = escolhido ? (escolhido.esperaMaximaS ?? PADRAO_S) : time.em_vigor_s;
  const campo = `espera-da-fila-${teamId}`;
  const rotulo = (segundos: number) => {
    const minutos = trocarMarcador(t("{n} minutos"), "{n}", String(segundos / 60));
    return segundos === PADRAO_S ? `${minutos} — ${t("padrão")}` : minutos;
  };

  return (
    <Card className="space-y-2 p-4" data-espera-da-fila={teamId}>
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Phone size={16} aria-hidden /> {t("Fila do telefone")}
      </h3>
      <p className="text-sm text-muted-foreground">
        {t(
          "Quanto tempo um cliente espera na fila do telefone deste time quando ninguém está livre. Depois disso a ligação cai e vira \"Ligar de volta\" na Central.",
        )}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={campo}>{t("Espera máxima")}</Label>
        <Select
          value={String(emVigor)}
          disabled={gravar.isPending}
          onValueChange={(v) => {
            const segundos = Number(v);
            gravar.mutate({ teamId, esperaMaximaS: segundos === PADRAO_S ? null : segundos });
          }}
        >
          <SelectTrigger id={campo} className="max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPCOES.includes(emVigor) ? null : (
              <SelectItem value={String(emVigor)}>{trocarMarcador(t("{n} segundos"), "{n}", String(emVigor))}</SelectItem>
            )}
            {OPCOES.map((s) => (
              <SelectItem key={s} value={String(s)}>
                {rotulo(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </Card>
  );
}
