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
 * - **Gerar** preenche e MOSTRA: uma senha gerada que ninguém viu é uma senha
 *   que ninguém consegue passar adiante.
 * - **Copiar** existe porque a próxima coisa que se faz com ela é mandá-la.
 * - `autoComplete="new-password"`: sem isso o navegador oferece salvar a senha
 *   DO MEMBRO como se fosse a de quem está logado.
 */
export function CampoDeSenha({
  id,
  value,
  onChange,
  mostrar,
  onMostrarChange,
  disabled = false,
}: {
  id: string;
  value: string;
  onChange: (senha: string) => void;
  mostrar: boolean;
  onMostrarChange: (mostrar: boolean) => void;
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
        type={mostrar ? "text" : "password"}
        autoComplete="new-password"
        spellCheck={false}
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
          onClick={() => {
            onChange(gerarSenha());
            onMostrarChange(true);
          }}
        >
          {t("Gerar senha")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-pressed={mostrar}
          onClick={() => onMostrarChange(!mostrar)}
        >
          {mostrar ? t("Ocultar") : t("Mostrar")}
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
