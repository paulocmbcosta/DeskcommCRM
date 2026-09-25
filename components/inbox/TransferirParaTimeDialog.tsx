"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useTimesDoInbox } from "@/hooks/inbox/useTimesDoInbox";
import { useTransferirParaTime } from "@/hooks/inbox/useTransferirParaTime";

interface Props {
  conversationId: string;
  /** O time em que a conversa está agora — `null` é a fila geral. */
  timeAtual: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/** O valor que representa "tirar do time" — `null` não viaja num `<Select>`. */
const FILA_GERAL = "none";

/**
 * Encaminhar a conversa para um SETOR (migration 0263).
 *
 * Irmão do `ReassignDialog`, que manda para uma PESSOA, e no mesmo formato de
 * propósito: são o mesmo gesto com destinos de natureza diferente, e duas
 * gramáticas para o mesmo gesto é como uma tela ensina duas coisas onde havia
 * uma.
 *
 * ⚠️ O ESTADO DO TIME APARECE ANTES DE MANDAR, NÃO DEPOIS.
 * Um setor fechado ACEITA a conversa — ela fica na fila dele até o próximo
 * horário —, e é por isso que a rota não recusa. Quem transfere é que precisa
 * saber: mandar para o financeiro numa sexta às 19h é uma decisão legítima se
 * for consciente, e um cliente esquecido se não for. O indicador fica ao lado
 * de CADA time, e não só do escolhido, porque a escolha se faz olhando a lista.
 */
export function TransferirParaTimeDialog({ conversationId, timeAtual, open, onOpenChange }: Props) {
  const t = useT();
  // Só busca quando o diálogo abre: o inbox inteiro não paga a consulta por uma
  // porta que quase nunca é aberta. A chave é a mesma do seletor de fila, então
  // quando ela JÁ foi buscada a abertura é instantânea.
  const times = useTimesDoInbox(open);
  const encaminhar = useTransferirParaTime();
  const [destino, setDestino] = useState<string>("");

  // Arquivado não é destino: ele existe na lista só para o selo saber nomear o
  // passado. Oferecê-lo aqui seria oferecer um setor que ninguém mais atende.
  //
  // O time ATUAL entra, e é de propósito: devolver a conversa à fila do próprio
  // time é a troca de turno — quem vai embora sai da conversa, a IA segue
  // calada e o rodízio entrega a outra pessoa do time, nunca de volta a ele.
  const opcoes = (times.data ?? []).filter((time) => !time.archived);
  const escolhido = (times.data ?? []).find((time) => time.id === destino) ?? null;

  function fechar(v: boolean) {
    if (!v) setDestino("");
    onOpenChange(v);
  }

  /** O sufixo que diz, em uma palavra, se o setor está atendendo agora. */
  function estado(time: { aberto_agora: boolean; horario_invalido: boolean }): string {
    if (time.horario_invalido) return t("horário inválido");
    return time.aberto_agora ? t("aberto agora") : t("fechado agora");
  }

  return (
    <Dialog open={open} onOpenChange={fechar}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Encaminhar para um time")}</DialogTitle>
          <DialogDescription>
            {t(
              "A conversa entra na fila do setor escolhido: quem atendia até agora deixa de ser o responsável, e o próximo atendente livre daquele time a recebe.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="time-destino">{t("Time de destino")}</Label>
            <Select value={destino} onValueChange={setDestino}>
              <SelectTrigger id="time-destino" className="w-full">
                <SelectValue
                  placeholder={times.isLoading ? t("Carregando times…") : t("Escolha o time")}
                />
              </SelectTrigger>
              <SelectContent>
                {/* Devolver à fila geral é destino, não desistência: é como se
                    tira uma conversa encaminhada por engano sem ter de escolher
                    outro setor para ela. Só aparece quando há de onde tirar. */}
                {timeAtual !== null && (
                  <SelectItem value={FILA_GERAL}>{t("Fila geral (sem time)")}</SelectItem>
                )}
                {opcoes.map((time) => (
                  <SelectItem key={time.id} value={time.id}>
                    {time.name}
                    <span className="ml-1 text-muted-foreground">
                      · {time.id === timeAtual ? t("devolver à fila") : estado(time)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!times.isLoading && opcoes.length === 0 && timeAtual === null && (
              <p className="text-xs text-muted-foreground">
                {t("Nenhum time cadastrado nesta organização.")}
              </p>
            )}
          </div>

          {/* O aviso repete o que a linha da lista já dizia, e a repetição é o
              ponto: entre escolher e clicar em Encaminhar, o rótulo do seletor
              some de vista. */}
          {escolhido && !escolhido.aberto_agora && (
            <p className="rounded-md bg-surface-elevated px-3 py-2 text-xs text-text-muted">
              {escolhido.horario_invalido
                ? t(
                    "O horário deste time está inválido e ninguém está recebendo por ele. A conversa fica parada até um gestor reconfigurar o horário.",
                  )
                : t(
                    "Este time está fechado agora. A conversa fica na fila dele até o próximo horário de atendimento.",
                  )}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => fechar(false)}>
            {t("Cancelar")}
          </Button>
          <Button
            disabled={!destino || encaminhar.isPending}
            onClick={() =>
              encaminhar.mutate(
                {
                  conversation_id: conversationId,
                  team_id: destino === FILA_GERAL ? null : destino,
                },
                { onSuccess: () => fechar(false) },
              )
            }
          >
            {encaminhar.isPending ? t("Encaminhando…") : t("Encaminhar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
