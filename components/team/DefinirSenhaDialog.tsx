"use client";

import { useState } from "react";
import { toast } from "sonner";

import { CampoDeSenha } from "@/components/team/CampoDeSenha";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/hooks/i18n/useT";
import { useDefinirSenha } from "@/hooks/team/useDefinirSenha";
import type { TeamMember } from "@/hooks/team/useTeamMembers";
import { ApiError } from "@/lib/api/types";

/**
 * "Definir nova senha" de um membro, aberto pelo menu da aba Membros.
 *
 * A recusa aparece DENTRO do diálogo, não num toast: as da rota explicam o que
 * fazer ("esta pessoa também faz parte de outra organização; só ela pode trocar
 * a própria senha"), e quem lê precisa do texto parado na tela.
 */
export function DefinirSenhaDialog({
  member,
  onClose,
}: {
  member: TeamMember;
  onClose: () => void;
}) {
  const t = useT();
  const definir = useDefinirSenha();
  const [senha, setSenha] = useState("");
  const [mostrar, setMostrar] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const nome = member.full_name ?? member.email ?? t("membro");

  const salvar = async () => {
    setErro(null);
    try {
      await definir.mutateAsync({ userId: member.user_id, password: senha });
      toast.success(`${t("Senha nova definida para")} ${nome}.`);
      onClose();
    } catch (err) {
      setErro(
        err instanceof ApiError
          ? err.code === "validation_error"
            ? t("A senha precisa ter de 8 a 72 caracteres.")
            : t(err.message)
          : t("Não foi possível trocar a senha. Tente novamente."),
      );
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !definir.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("Definir nova senha")} — {nome}
          </DialogTitle>
          <DialogDescription>
            {t("A senha antiga deixa de valer. Passe a nova para a pessoa; ela entra com o mesmo e-mail.")}
          </DialogDescription>
        </DialogHeader>
        <form
          id="definir-senha"
          onSubmit={(e) => {
            e.preventDefault();
            void salvar();
          }}
        >
          <CampoDeSenha
            id="definir-senha-campo"
            value={senha}
            onChange={setSenha}
            mostrar={mostrar}
            onMostrarChange={setMostrar}
            disabled={definir.isPending}
          />
        </form>
        {erro ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {erro}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={definir.isPending}>
            {t("Cancelar")}
          </Button>
          <Button
            type="submit"
            form="definir-senha"
            disabled={definir.isPending || senha.length < 8}
          >
            {definir.isPending ? t("Salvando…") : t("Salvar senha")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
