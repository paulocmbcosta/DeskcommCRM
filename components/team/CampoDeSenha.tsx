"use client";

import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { copyToClipboard } from "@/lib/clipboard";
import { gerarSenha } from "@/lib/team/gerar-senha";

/**
 * O campo da senha que QUEM ADMINISTRA escolhe para outra pessoa — no cadastro
 * de membro e no "Definir nova senha".
 *
 * Não é o campo de senha do login, e três escolhas saem disso:
 *
 * - **Texto visível, não `type="password"`.** A senha existe para ser passada
 *   adiante: esconder de quem a escolheu não protege nada. E um `password` ao
 *   lado de um campo de e-mail, num formulário que limpa depois de enviar, é
 *   exatamente o sinal para o navegador oferecer "salvar senha" — a senha do
 *   MEMBRO iria parar no cofre de senhas do admin, associada a este site.
 * - **Gerar** preenche uma senha fácil de ditar (sem 0/O nem 1/l/I).
 * - **Copiar** existe porque a próxima coisa que se faz com ela é mandá-la.
 */
export function CampoDeSenha({
  id,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  value: string;
  onChange: (senha: string) => void;
  disabled?: boolean;
}) {
  const t = useT();

  const copiar = async () => {
    if (await copyToClipboard(value)) toast.success(t("Senha copiada."));
    else toast.error(t("Não foi possível copiar. Selecione a senha e copie à mão."));
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("Senha")}</Label>
      <Input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        // Os gerenciadores de senha mais comuns respeitam estes atributos e não
        // tratam o campo como credencial de quem está logado.
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="font-mono"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange(gerarSenha())}
        >
          {t("Gerar senha")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || value.length === 0}
          onClick={() => void copiar()}
        >
          {t("Copiar")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("Mínimo de 8 caracteres. É você quem vai passar esta senha para a pessoa.")}
      </p>
    </div>
  );
}
