"use client";
import { useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useUnblockContact } from "@/hooks/contacts/useUnblockContact";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  contactId: string;
  /** Nome como a tela o mostra — o diálogo diz QUEM volta a receber. */
  nome: string;
  /** `contacts.blocked_at`, quando a tela o tem — o diálogo diz desde quando. */
  bloqueadoEm?: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const MINIMO = 10;

/**
 * A CONFIRMAÇÃO DIZ O QUE ESTÁ EM JOGO, e não só "tem certeza?".
 *
 * O bloqueio nasce de uma frase do cliente que o sistema leu como pedido de
 * saída. Pode ter sido falso positivo — foi o caso que motivou esta porta —, mas
 * pode ter sido pedido de verdade, e aí desbloquear é voltar a escrever para
 * quem pediu para parar (LGPD). O diálogo existe para a pessoa decidir sabendo
 * disso, com um motivo que fica gravado junto do nome dela na auditoria.
 *
 * A caixa de "confirmo" não é enfeite: é a afirmação que o motivo sozinho não
 * faz — que quem desbloqueia CONFERIU a conversa.
 */
export function DesbloquearContatoDialog({ contactId, nome, bloqueadoEm, open, onOpenChange }: Props) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const desbloquear = useUnblockContact();
  const [motivo, setMotivo] = useState("");
  const [conferi, setConferi] = useState(false);

  function reset() {
    setMotivo("");
    setConferi(false);
  }

  function handleOpenChange(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  async function handleSubmit() {
    try {
      await desbloquear.mutateAsync({ contact_id: contactId, motivo: motivo.trim() });
      toast.success(t("Contato desbloqueado. Ele volta a receber mensagens."));
      reset();
      onOpenChange(false);
    } catch {
      // o hook mostra o erro
    }
  }

  const tamanho = motivo.trim().length;
  const pronto = tamanho >= MINIMO && conferi && !desbloquear.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="dialogo-desbloquear-contato">
        <DialogHeader>
          <DialogTitle>{t("Desbloquear contato")}</DialogTitle>
          <DialogDescription>
            {nome}
            {bloqueadoEm
              ? ` · ${t("bloqueado em")} ${format(new Date(bloqueadoEm), "dd/MM/yyyy HH:mm", { locale: localeDaData })}`
              : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2 rounded-md border border-warning-fg/30 bg-warning-bg p-3 text-sm text-warning-fg">
            <p>
              {t(
                "Este contato foi bloqueado porque o sistema entendeu que ele pediu para não receber mensagens. Pode ter sido um engano — mas pode ter sido um pedido de verdade.",
              )}
            </p>
            <p>
              {t(
                "Desbloqueie só depois de conferir a conversa. Voltar a escrever para quem pediu para sair desrespeita o cliente e a LGPD. Seu nome e o motivo ficam registrados na auditoria.",
              )}
            </p>
            <p>
              {t(
                "O que foi cancelado enquanto ele estava bloqueado não volta a ser enviado. Se ele pedir para sair de novo, o bloqueio volta sozinho.",
              )}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="desbloqueio-motivo">{t("Motivo do desbloqueio")}</Label>
            <Textarea
              id="desbloqueio-motivo"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder={t("Ex.: o cliente pediu para cancelar o plano, não para sair da lista.")}
              rows={3}
              maxLength={500}
            />
            <p className="text-xs text-muted-foreground">
              {tamanho}/{MINIMO} {t("caracteres mínimos")}
            </p>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={conferi}
              onChange={(e) => setConferi(e.target.checked)}
            />
            <span>{t("Conferi a conversa e o cliente não pediu para deixar de receber mensagens.")}</span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={desbloquear.isPending}>
            {t("Cancelar")}
          </Button>
          <Button onClick={handleSubmit} disabled={!pronto} data-testid="confirmar-desbloqueio">
            {desbloquear.isPending ? t("Desbloqueando…") : t("Desbloquear")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
