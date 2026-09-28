"use client";
/**
 * Conexões › Telefone (spec 20 §7) — os números SIP da organização.
 *
 * Cada número é a conta que a empresa contratou de uma operadora de telefonia:
 * servidor, usuário e senha, mais o time que atende as ligações dele. Dá para
 * conectar quantos números quiser. A senha só é ESCRITA: depois de salva, a tela
 * mostra que existe, nunca qual é — editar sem digitar mantém a guardada.
 *
 * O estado de cada número (Conectado / senha recusada / sem resposta) vem do
 * registro de verdade na operadora, que o worker lê do Asterisk. Enquanto algum
 * número está conectando, a lista se atualiza a cada 3 s — é o retorno que
 * quem acabou de digitar a senha está esperando.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { useTimesDoInbox } from "@/hooks/inbox/useTimesDoInbox";
import { apiClient } from "@/lib/api/client";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { PencilSimple, Phone, Plus, Trash } from "@/lib/ui/icons";

interface NumeroSip {
  id: string;
  nome: string | null;
  numero: string | null;
  servidor: string;
  porta: number;
  transporte: "udp" | "tcp";
  usuario: string;
  time_id: string | null;
  time_nome: string | null;
  status: string;
  status_reason: string | null;
}

interface Formulario {
  nome: string;
  numero: string;
  servidor: string;
  porta: string;
  transporte: "udp" | "tcp";
  usuario: string;
  senha: string;
  time_id: string;
}

const VAZIO: Formulario = {
  nome: "",
  numero: "",
  servidor: "",
  porta: "5060",
  transporte: "udp",
  usuario: "",
  senha: "",
  time_id: "",
};

const SEM_TIME = "__nenhum__";

function Situacao({ n }: { n: NumeroSip }) {
  const t = useT();
  if (n.status === "WORKING") {
    return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">{t("Conectado")}</Badge>;
  }
  if (n.status === "FAILED") {
    const motivo =
      n.status_reason === "registro_recusado"
        ? t("A operadora recusou o usuário ou a senha")
        : n.status_reason === "senha_ilegivel"
          ? t("A senha guardada não pôde ser lida — digite de novo")
          : n.status_reason === "configuracao_invalida"
            ? t("Servidor ou usuário inválido — edite o número")
            : t("A operadora não respondeu");
    return (
      <Badge variant="destructive" title={motivo}>
        {motivo}
      </Badge>
    );
  }
  return <Badge variant="secondary">{t("Conectando…")}</Badge>;
}

export function CanalTelefoneClient() {
  const t = useT();
  const qc = useQueryClient();
  const times = useTimesDoInbox();
  const [editando, setEditando] = useState<string | "novo" | null>(null);
  const [form, setForm] = useState<Formulario>(VAZIO);
  const [salvando, setSalvando] = useState(false);

  const consulta = useQuery({
    queryKey: ["telefonia", "numeros"],
    queryFn: async () =>
      (await apiClient.get<{ data: { oferecida: boolean; numeros: NumeroSip[] } }>("/api/v1/telefonia/numeros")).data,
    refetchInterval: (q) => (q.state.data?.numeros.some((n) => n.status === "STARTING") ? 3_000 : 15_000),
  });

  const campo = (k: keyof Formulario) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const abrirNovo = () => {
    setForm(VAZIO);
    setEditando("novo");
  };
  const abrirEdicao = (n: NumeroSip) => {
    setForm({
      nome: n.nome ?? "",
      numero: n.numero ? phoneForDisplay(n.numero) : "",
      servidor: n.servidor,
      porta: String(n.porta),
      transporte: n.transporte,
      usuario: n.usuario,
      senha: "",
      time_id: n.time_id ?? "",
    });
    setEditando(n.id);
  };

  const salvar = async () => {
    setSalvando(true);
    const corpo = {
      nome: form.nome,
      numero: form.numero,
      servidor: form.servidor,
      porta: Number(form.porta) || 5060,
      transporte: form.transporte,
      usuario: form.usuario,
      ...(form.senha ? { senha: form.senha } : {}),
      time_id: form.time_id || null,
    };
    try {
      if (editando === "novo") await apiClient.post("/api/v1/telefonia/numeros", corpo);
      else await apiClient.patch(`/api/v1/telefonia/numeros/${editando}`, corpo);
      toast.success(t("Número salvo. Conectando à operadora…"));
      // O telefone do cabeçalho (TelefoniaContext) pede o ramal de novo: com o
      // primeiro número, este navegador passa a poder ligar sem recarregar.
      window.dispatchEvent(new Event("telefonia:numeros-mudaram"));
      setEditando(null);
      setForm(VAZIO);
      await qc.invalidateQueries({ queryKey: ["telefonia", "numeros"] });
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  };

  const remover = async (n: NumeroSip) => {
    if (!window.confirm(t("Remover este número? As ligações e conversas dele continuam no histórico."))) return;
    try {
      await apiClient.delete(`/api/v1/telefonia/numeros/${n.id}`);
      toast.success(t("Número removido."));
      await qc.invalidateQueries({ queryKey: ["telefonia", "numeros"] });
    } catch (e) {
      showApiError(e);
    }
  };

  if (consulta.isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  const dados = consulta.data;

  if (dados && !dados.oferecida) {
    return (
      <Card className="space-y-2 p-5" data-telefonia-desligada>
        <h2 className="text-base font-semibold">{t("Telefonia desligada nesta instalação")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Para fazer e receber ligações pelo CRM, quem administra o servidor precisa ligar a telefonia (perfil “telefonia” do Docker Compose) e rodar a atualização. Depois disso, os números são cadastrados aqui.",
          )}
        </p>
      </Card>
    );
  }

  const numeros = dados?.numeros ?? [];
  const formularioAberto = editando !== null;
  const podeSalvar =
    form.nome.trim() && form.numero.trim() && form.servidor.trim() && form.usuario.trim() && (editando !== "novo" || form.senha);

  return (
    <div className="space-y-4">
      <Card className="space-y-1 p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Phone size={18} aria-hidden /> {t("Números de telefone")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Conecte as contas SIP que sua empresa contratou de uma operadora. As ligações recebidas tocam no navegador dos atendentes do time escolhido, um por vez, começando por quem atendeu menos hoje.",
          )}
        </p>
      </Card>

      {numeros.length === 0 && !formularioAberto ? (
        <Card className="flex flex-col items-start gap-3 p-5">
          <p className="text-sm text-muted-foreground">{t("Nenhum número conectado ainda.")}</p>
          <Button onClick={abrirNovo}>
            <Plus size={16} aria-hidden /> {t("Adicionar número")}
          </Button>
        </Card>
      ) : null}

      {numeros.map((n) => (
        <Card key={n.id} className="flex flex-wrap items-center gap-3 p-4" data-telefonia-numero={n.status}>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{n.nome ?? phoneForDisplay(n.numero ?? "")}</p>
            <p className="truncate text-xs text-muted-foreground">
              {phoneForDisplay(n.numero ?? "")} · {n.usuario}@{n.servidor}
              {n.porta !== 5060 ? `:${n.porta}` : ""} · {n.transporte.toUpperCase()}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {n.time_nome ? `${t("Recebe:")} ${n.time_nome}` : t("Nenhum time recebe as ligações deste número")}
            </p>
          </div>
          <Situacao n={n} />
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" aria-label={t("Editar")} onClick={() => abrirEdicao(n)}>
              <PencilSimple size={16} aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" aria-label={t("Remover")} onClick={() => void remover(n)}>
              <Trash size={16} aria-hidden />
            </Button>
          </div>
        </Card>
      ))}

      {numeros.length > 0 && !formularioAberto ? (
        <Button variant="outline" onClick={abrirNovo}>
          <Plus size={16} aria-hidden /> {t("Adicionar outro número")}
        </Button>
      ) : null}

      {formularioAberto ? (
        <Card className="space-y-4 p-5" data-telefonia-formulario>
          <h3 className="text-sm font-semibold">{editando === "novo" ? t("Novo número") : t("Editar número")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tel-nome">{t("Nome")}</Label>
              <Input id="tel-nome" value={form.nome} onChange={campo("nome")} placeholder={t("Ex.: Central de atendimento")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tel-numero">{t("Número")}</Label>
              <Input id="tel-numero" inputMode="tel" value={form.numero} onChange={campo("numero")} placeholder="(61) 3686-1503" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tel-servidor">{t("Servidor SIP")}</Label>
              <Input
                id="tel-servidor"
                value={form.servidor}
                onChange={campo("servidor")}
                placeholder="voip.operadora.com.br"
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="tel-porta">{t("Porta")}</Label>
                <Input id="tel-porta" inputMode="numeric" value={form.porta} onChange={campo("porta")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tel-transporte">{t("Transporte")}</Label>
                <Select value={form.transporte} onValueChange={(v) => setForm((f) => ({ ...f, transporte: v as "udp" | "tcp" }))}>
                  <SelectTrigger id="tel-transporte">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="udp">UDP</SelectItem>
                    <SelectItem value="tcp">TCP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tel-usuario">{t("Usuário")}</Label>
              <Input
                id="tel-usuario"
                value={form.usuario}
                onChange={campo("usuario")}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tel-senha">{t("Senha")}</Label>
              <Input
                id="tel-senha"
                type="password"
                autoComplete="new-password"
                value={form.senha}
                onChange={campo("senha")}
                placeholder={editando === "novo" ? "" : t("Deixe em branco para manter a atual")}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="tel-time">{t("Time que recebe as ligações")}</Label>
              <Select
                value={form.time_id || SEM_TIME}
                onValueChange={(v) => setForm((f) => ({ ...f, time_id: v === SEM_TIME ? "" : v }))}
              >
                <SelectTrigger id="tel-time">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SEM_TIME}>{t("Nenhum (só ligações de saída)")}</SelectItem>
                  {(times.data ?? [])
                    .filter((x) => !x.archived)
                    .map((x) => (
                      <SelectItem key={x.id} value={x.id}>
                        {x.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("A senha fica cifrada no banco e não é mostrada de novo. Os dados de acesso são fornecidos pela sua operadora de telefonia.")}
          </p>
          <div className="flex gap-2">
            <Button onClick={() => void salvar()} disabled={!podeSalvar || salvando}>
              {salvando ? t("Salvando…") : t("Salvar e conectar")}
            </Button>
            <Button variant="ghost" onClick={() => setEditando(null)} disabled={salvando}>
              {t("Cancelar")}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
