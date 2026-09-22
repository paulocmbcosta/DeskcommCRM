"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { trocarMinhaSenha, type TrocarMinhaSenhaResult } from "@/app/actions/settings/trocarMinhaSenha";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

type Recusa = Extract<TrocarMinhaSenhaResult, { ok: false }>["error"];

/** O que a tela diz para cada recusa — texto que diz o que fazer, não o código. */
const MENSAGEM: Record<Recusa, string> = {
  validation_error: "A senha nova precisa ter de 8 a 72 caracteres.",
  nao_confere: "A confirmação não é igual à senha nova.",
  igual_a_atual: "A senha nova é igual à atual. Escolha outra.",
  unauthenticated: "Sua sessão terminou. Entre de novo para trocar a senha.",
  rate_limited: "Muitas tentativas. Espere alguns minutos e tente de novo.",
  senha_atual_incorreta: "A senha atual não confere.",
  mfa_required: "Entre de novo com o código do aplicativo para trocar a senha.",
  senha_recusada:
    "A senha nova foi recusada pela política de senhas desta instalação. Escolha outra, mais longa e menos óbvia.",
  update_failed: "Não foi possível trocar a senha. Tente novamente.",
};

/**
 * Trocar a própria senha, logado. Existe desde que o admin passou a poder
 * cadastrar membro já com senha: é aqui que a pessoa toma posse dela — e sem
 * depender de e-mail, que numa instalação nova costuma não estar configurado.
 *
 * `autoComplete` de login DE VERDADE aqui (current/new-password): ao contrário
 * do campo em que o admin define a senha de outra pessoa, esta é a senha de
 * quem está digitando, e o gerenciador de senhas oferecer para salvar é certo.
 */
export function TrocarSenhaForm() {
  const t = useT();
  const [atual, setAtual] = useState("");
  const [nova, setNova] = useState("");
  const [confirmacao, setConfirmacao] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    startTransition(async () => {
      const r = await trocarMinhaSenha({ senha_atual: atual, nova, confirmacao });
      if (r.ok) {
        toast.success(t("Senha trocada. Use a nova na próxima entrada."));
        setAtual("");
        setNova("");
        setConfirmacao("");
        return;
      }
      setErro(t(MENSAGEM[r.error]));
    });
  }

  return (
    <form onSubmit={onSubmit} className="max-w-xl" aria-labelledby="trocar-senha-titulo">
      <Card className="space-y-4 p-6">
        <div>
          <h2 id="trocar-senha-titulo" className="text-base font-semibold">
            {t("Trocar senha")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("Se quem administra definiu sua senha, troque-a aqui por uma que só você conhece.")}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="senha-atual">{t("Senha atual")}</Label>
          <Input
            id="senha-atual"
            type="password"
            autoComplete="current-password"
            value={atual}
            onChange={(e) => setAtual(e.target.value)}
            disabled={isPending}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="senha-nova">{t("Senha nova")}</Label>
            <Input
              id="senha-nova"
              type="password"
              autoComplete="new-password"
              value={nova}
              onChange={(e) => setNova(e.target.value)}
              disabled={isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="senha-confirmacao">{t("Confirmar senha nova")}</Label>
            <Input
              id="senha-confirmacao"
              type="password"
              autoComplete="new-password"
              value={confirmacao}
              onChange={(e) => setConfirmacao(e.target.value)}
              disabled={isPending}
            />
          </div>
        </div>
        {erro ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {erro}
          </p>
        ) : null}
        <div className="flex sm:justify-end">
          <Button
            type="submit"
            disabled={isPending || !atual || nova.length < 8 || !confirmacao}
            className="w-full sm:w-auto"
          >
            {isPending ? t("Trocando…") : t("Trocar senha")}
          </Button>
        </div>
      </Card>
    </form>
  );
}
