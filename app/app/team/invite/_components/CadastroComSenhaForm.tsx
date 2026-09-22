"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { CampoDeSenha } from "@/components/team/CampoDeSenha";
import { InterfaceEditor } from "@/components/team/InterfaceEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { useCadastrarMembro, type MembroCadastrado } from "@/hooks/team/useCadastrarMembro";
import { ApiError } from "@/lib/api/types";
import {
  INTERFACE_COMPLETA,
  interfaceSettingsSchema,
  interfaceTemDestino,
} from "@/lib/navigation/interface";
import { ROLES, type Role } from "@/lib/schemas/team";

/**
 * O resultado guarda a senha DIGITADA, não a que voltou da API — a API não a
 * devolve. Ela vive só neste estado do browser de quem cadastrou, até a
 * próxima submissão ou até sair da tela.
 */
interface Resultado extends MembroCadastrado {
  password: string;
}

export function CadastroComSenhaForm() {
  const t = useT();
  const cadastrar = useCadastrarMembro();
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [mostrar, setMostrar] = useState(false);
  const [role, setRole] = useState<Role>("agent");
  const [settings, setSettings] = useState(INTERFACE_COMPLETA);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  const areasValidas =
    interfaceSettingsSchema.safeParse(settings).success && interfaceTemDestino(settings, role);
  const pronto =
    nome.trim().length >= 2 && email.trim().length > 0 && senha.length >= 8 && areasValidas;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErro(null);
    if (senha.length < 8) {
      setErro(t("A senha precisa de pelo menos 8 caracteres."));
      return;
    }
    try {
      const res = await cadastrar.mutateAsync({
        full_name: nome.trim(),
        email: email.trim().toLowerCase(),
        password: senha,
        role,
        interface_settings: settings,
      });
      setResultado({ ...res.data, password: senha });
      toast.success(`${res.data.full_name} ${t("entrou na equipe.")}`);
      setNome("");
      setEmail("");
      setSenha("");
      setMostrar(false);
    } catch (err) {
      setErro(
        err instanceof ApiError
          ? err.code === "validation_error"
            ? t("Confira os campos: nome, e-mail válido e senha de 8 a 72 caracteres.")
            : t(err.message)
          : t("Não foi possível cadastrar o membro. Tente novamente."),
      );
    }
  };

  const textoDeAcesso = resultado
    ? [
        `${t("Endereço")}: ${resultado.login_url}`,
        `${t("E-mail")}: ${resultado.email}`,
        `${t("Senha")}: ${resultado.password}`,
      ].join("\n")
    : "";

  const copiarAcesso = async () => {
    try {
      await navigator.clipboard.writeText(textoDeAcesso);
      toast.success(t("Dados de acesso copiados."));
    } catch {
      toast.error(t("Não foi possível copiar. Selecione o texto e copie à mão."));
    }
  };

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_2fr]">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="membro-nome">{t("Nome")}</Label>
          <Input
            id="membro-nome"
            autoComplete="off"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            disabled={cadastrar.isPending}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="membro-email">{t("E-mail")}</Label>
          <Input
            id="membro-email"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="maria@empresa.com"
            disabled={cadastrar.isPending}
          />
        </div>
        <CampoDeSenha
          id="membro-senha"
          value={senha}
          onChange={setSenha}
          mostrar={mostrar}
          onMostrarChange={setMostrar}
          disabled={cadastrar.isPending}
        />
        <div className="space-y-2">
          <Label htmlFor="membro-papel">{t("Papel")}</Label>
          <Select value={role} onValueChange={(v) => setRole(v as Role)}>
            <SelectTrigger id="membro-papel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <InterfaceEditor
          value={settings}
          onChange={setSettings}
          role={role}
          disabled={cadastrar.isPending}
        />
        {erro ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {erro}
          </p>
        ) : null}
        <Button type="submit" disabled={cadastrar.isPending || !pronto}>
          {cadastrar.isPending ? t("Cadastrando…") : t("Cadastrar membro")}
        </Button>
      </form>

      <div className="space-y-4">
        {resultado ? (
          <section
            aria-label={t("Dados de acesso")}
            className="space-y-3 rounded-md border p-4"
          >
            <div>
              <h2 className="text-sm font-semibold">
                {resultado.full_name} {t("já pode entrar.")}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t("Passe estes dados para a pessoa. A senha não fica guardada nesta tela: copie agora.")}
              </p>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t("Endereço")}</dt>
              <dd className="break-all font-mono">{resultado.login_url}</dd>
              <dt className="text-muted-foreground">{t("E-mail")}</dt>
              <dd className="break-all font-mono">{resultado.email}</dd>
              <dt className="text-muted-foreground">{t("Senha")}</dt>
              <dd className="break-all font-mono">{resultado.password}</dd>
              <dt className="text-muted-foreground">{t("Papel")}</dt>
              <dd>{resultado.role}</dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void copiarAcesso()}>
                {t("Copiar dados de acesso")}
              </Button>
              {resultado.entregue ? null : (
                <Button asChild variant="outline">
                  <Link href="/app/team">{t("Ver a equipe")}</Link>
                </Button>
              )}
            </div>
            {resultado.entregue ? (
              <div role="status" className="space-y-2 rounded-md bg-muted p-3 text-sm">
                <p>
                  {t(
                    "Você criou esta organização para outra pessoa e acabou de cadastrar um administrador: a organização foi entregue a essa pessoa, e você saiu dela.",
                  )}
                </p>
                <Button asChild size="sm" variant="outline">
                  <Link href="/app">{t("Continuar")}</Link>
                </Button>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t("Esqueceu a senha depois? Em Equipe › Membros, use “Definir nova senha” no menu da pessoa.")}
            </p>
          </section>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("Os dados de acesso aparecem aqui depois do cadastro.")}
          </p>
        )}
      </div>
    </div>
  );
}
