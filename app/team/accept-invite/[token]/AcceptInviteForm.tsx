"use client";
import { useActionState } from "react";
import { acceptInviteAction, type AcceptInviteResult } from "@/app/actions/team/acceptInvite";

export function AcceptInviteForm({ token, label, failureLabel, pendingLabel, senhaDoAdminLabel }: { token: string; label: string; failureLabel: string; pendingLabel: string; senhaDoAdminLabel: string }) {
  const [result, submit, pending] = useActionState<AcceptInviteResult | null, FormData>(
    async () => acceptInviteAction(token), null,
  );
  // A recusa por senha definida por admin tem SAÍDA — trocar a própria senha —,
  // e dizer "o convite pode ter vencido" mandaria a pessoa pedir outro link à toa.
  return <form action={submit} className="mt-4 space-y-3">
    {result && !result.ok && <p role="alert">{result.error === "senha_definida_por_admin" ? senhaDoAdminLabel : failureLabel}</p>}
    <button type="submit" disabled={pending}
      className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
      {pending ? pendingLabel : label}
    </button>
  </form>;
}
