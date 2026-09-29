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
 *
 * O prefixo de discagem é do NÚMERO (migration 0287): cada operadora pede o
 * seu antes do DDD — a Totus recusa `61…` e completa `061…`. Vazio = DDD +
 * número, como antes. Mudar só o prefixo não pede a senha: não é a conta.
 *
 * "Quando ligarem" (fase 2, desenho §6.2): o número TOCA NO TIME ou TOCA O MENU
 * de voz — um destino só (CHECK `channel_sessions_sip_destino_check`): o PATCH
 * manda o escolhido e o outro nulo. Menu com a fala pendente aparece
 * desabilitado, com o motivo (a rota recusaria). Time ou menu ARQUIVADO não é
 * opção; o número que aponta para um deles diz isso no cartão (a leitura do
 * número traz `time_arquivado`/`menu_arquivado`) e o formulário só salva com
 * outro destino. A recusa da rota aparece com a frase dela (`mensagemDoServidor`);
 * sem frase do servidor (o 504 de um proxy), com a da tela — nunca o texto cru.
 *
 * A página inteira de Conexões é de admin, como as rotas dos números e dos
 * menus: não há o que esconder aqui por papel além disso.
 */
import Link from "next/link";
import { useRef, useState } from "react";
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
import { useTimesDoInbox, type TimeDoInbox } from "@/hooks/inbox/useTimesDoInbox";
import { apiClient } from "@/lib/api/client";
import { mensagemDoServidor } from "@/lib/api/types";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { prefixoDeDiscagemValido } from "@/lib/channels/telefonia/conta-sip";
import { randomId } from "@/lib/random-id";
import { estaArquivado } from "@/lib/telefonia/falta-no-menu";
import { PencilSimple, Phone, Plus, Trash, Warning } from "@/lib/ui/icons";

import { useMenusDoTelefone } from "./telefone/api";
import { TelefoniaDesligada } from "./telefone/TelefoniaDesligada";

interface NumeroSip {
  id: string;
  nome: string | null;
  numero: string | null;
  servidor: string;
  porta: number;
  transporte: "udp" | "tcp";
  usuario: string;
  prefixo: string | null;
  time_id: string | null;
  time_nome: string | null;
  /** O time foi arquivado (fase 2). Ausente numa resposta antiga — um recibo de idempotência, por exemplo. */
  time_arquivado?: boolean;
  /** O menu de voz que atende este número (fase 2). Ausente numa API antiga. */
  menu_id?: string | null;
  menu_nome?: string | null;
  menu_arquivado?: boolean;
  status: string;
  status_reason: string | null;
}

type Destino = "time" | "menu";

interface Formulario {
  nome: string;
  numero: string;
  servidor: string;
  porta: string;
  transporte: "udp" | "tcp";
  usuario: string;
  senha: string;
  prefixo: string;
  time_id: string;
  destino: Destino;
  menu_id: string;
}

const VAZIO: Formulario = {
  nome: "",
  numero: "",
  servidor: "",
  porta: "5060",
  transporte: "udp",
  usuario: "",
  senha: "",
  prefixo: "",
  time_id: "",
  destino: "time",
  menu_id: "",
};

const SEM_TIME = "__nenhum__";
const SEM_MENU = "__sem_menu__";

/** Onde se criam os menus: a aba Menus do Telefone. */
const ABA_DOS_MENUS = "/app/connections?aba=telefone&sub=menus";

/**
 * O time do número foi arquivado — pela leitura do número ou pela lista de times,
 * a que souber primeiro (as duas são marcas explícitas; um id que nenhuma conhece
 * fica com a rota, que é a autoridade).
 */
function timeArquivado(n: NumeroSip, times: readonly TimeDoInbox[]): boolean {
  if (!n.time_id) return false;
  return n.time_arquivado === true || estaArquivado(times, n.time_id);
}

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
  const [falhaAoSalvar, setFalhaAoSalvar] = useState<string | null>(null);
  // A lista de menus só serve ao formulário: o cartão lê o menu na própria linha do número.
  const consultaDosMenus = useMenusDoTelefone(editando !== null);
  // A chave de idempotência da CRIAÇÃO, por formulário. Repetir o MESMO formulário
  // (o salvar cuja resposta se perdeu — timeout, rede, 504) reusa a chave: se a
  // tentativa anterior chegou a gravar, a rota devolve o número dela em vez de
  // recusar como repetido. Qualquer mudança no formulário (inclusive a senha, que
  // a rota deixa FORA da identidade da chave) ganha chave nova. A comparação é
  // pela IDENTIDADE do objeto do formulário — nenhuma cópia da senha é guardada.
  const recibo = useRef<{ form: Formulario; chave: string } | null>(null);

  const consulta = useQuery({
    queryKey: ["telefonia", "numeros"],
    queryFn: async () =>
      (await apiClient.get<{ data: { oferecida: boolean; numeros: NumeroSip[] } }>("/api/v1/telefonia/numeros")).data,
    refetchInterval: (q) => (q.state.data?.numeros.some((n) => n.status === "STARTING") ? 3_000 : 15_000),
  });

  const campo = (k: keyof Formulario) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const fecharFormulario = () => {
    setEditando(null);
    setForm(VAZIO);
    setFalhaAoSalvar(null);
    recibo.current = null;
  };
  const abrirNovo = () => {
    setForm(VAZIO);
    setFalhaAoSalvar(null);
    recibo.current = null;
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
      prefixo: n.prefixo ?? "",
      time_id: n.time_id ?? "",
      destino: n.menu_id ? "menu" : "time",
      menu_id: n.menu_id ?? "",
    });
    setFalhaAoSalvar(null);
    setEditando(n.id);
  };

  const salvar = async () => {
    setSalvando(true);
    setFalhaAoSalvar(null);
    const corpo = {
      nome: form.nome,
      numero: form.numero,
      servidor: form.servidor,
      porta: Number(form.porta) || 5060,
      transporte: form.transporte,
      usuario: form.usuario,
      ...(form.senha ? { senha: form.senha } : {}),
      // Vazio apaga o prefixo (a rota grava nulo).
      prefixo: form.prefixo.trim(),
      // Um destino só (CHECK channel_sessions_sip_destino_check): o time OU o menu.
      // O outro vai NULO de propósito — escolher o time tira o menu, e vice-versa.
      time_id: form.destino === "time" ? form.time_id || null : null,
      menu_id: form.destino === "menu" ? form.menu_id || null : null,
    };
    try {
      if (editando === "novo") {
        if (recibo.current?.form !== form) recibo.current = { form, chave: randomId() };
        await apiClient.post("/api/v1/telefonia/numeros", corpo, { idempotencyKey: recibo.current.chave });
      } else {
        await apiClient.patch(`/api/v1/telefonia/numeros/${editando}`, corpo);
      }
      toast.success(t("Número salvo. Conectando à operadora…"));
      // O telefone do cabeçalho (TelefoniaContext) pede o ramal de novo: com o
      // primeiro número, este navegador passa a poder ligar sem recarregar.
      window.dispatchEvent(new Event("telefonia:numeros-mudaram"));
      fecharFormulario();
      await qc.invalidateQueries({ queryKey: ["telefonia", "numeros"] });
    } catch (e) {
      // A frase da ROTA (a recusa dela já diz o que fazer); sem frase do servidor
      // — o 504 de um proxy, a rede —, a da tela. Nunca o texto cru do erro.
      const doServidor = mensagemDoServidor(e);
      setFalhaAoSalvar(doServidor ? t(doServidor) : t("Não foi possível salvar o número. Tente de novo em instantes."));
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

  if (dados && !dados.oferecida) return <TelefoniaDesligada />;

  const numeros = dados?.numeros ?? [];
  const formularioAberto = editando !== null;
  const prefixoDigitado = form.prefixo.trim();
  const prefixoOk = prefixoDigitado === "" || prefixoDeDiscagemValido(prefixoDigitado);

  const listaDeTimes = times.data ?? [];
  const timesAtivos = listaDeTimes.filter((x) => !x.archived);
  const menus = consultaDosMenus.data?.menus ?? [];
  // O número em edição, como o servidor o descreve AGORA: o destino dele entra no
  // seletor mesmo quando não é opção válida (arquivado, ou a lista ainda não veio)
  // — sem isso o seletor ficaria em branco, escondendo para onde o número aponta.
  const atual = editando !== null && editando !== "novo" ? numeros.find((n) => n.id === editando) : undefined;
  const timeAtualArquivado = atual ? timeArquivado(atual, listaDeTimes) : false;
  const timeAtualForaDaLista = atual?.time_id && !timesAtivos.some((x) => x.id === atual.time_id) ? atual.time_id : null;
  const menuAtualForaDaLista = atual?.menu_id && !menus.some((m) => m.id === atual.menu_id) ? atual.menu_id : null;
  const menuEscolhido = menus.find((m) => m.id === form.menu_id);

  // O destino escolhido que a rota recusaria com certeza — com o porquê, ao lado do seletor.
  const bloqueioDoDestino =
    form.destino === "time" && form.time_id !== "" && form.time_id === atual?.time_id && timeAtualArquivado
      ? t("O time escolhido foi arquivado e não recebe ligações. Escolha outro time.")
      : form.destino === "menu" && form.menu_id !== "" && form.menu_id === atual?.menu_id && atual.menu_arquivado === true
        ? t("O menu escolhido foi arquivado. Escolha outro menu ou toque no time.")
        : form.destino === "menu" && menuEscolhido?.pronto === false
          ? t("A fala deste menu ainda não está pronta. Gere a prévia e salve o menu na aba Menus.")
          : null;

  const podeSalvar =
    form.nome.trim() &&
    form.numero.trim() &&
    form.servidor.trim() &&
    form.usuario.trim() &&
    prefixoOk &&
    (editando !== "novo" || form.senha) &&
    (form.destino === "time" || form.menu_id !== "") &&
    !bloqueioDoDestino;

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
              {n.prefixo ? (
                <span data-telefonia-prefixo>
                  {" · "}
                  {t("Prefixo de discagem:")} {n.prefixo}
                </span>
              ) : null}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {n.menu_nome
                ? `${t("Quando ligarem: menu")} ${n.menu_nome}`
                : n.time_nome
                  ? `${t("Recebe:")} ${n.time_nome}`
                  : t("Nenhum time recebe as ligações deste número")}
            </p>
            {n.menu_nome && n.menu_arquivado ? (
              <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400" data-destino-arquivado="menu">
                <Warning size={14} aria-hidden className="mt-px shrink-0" />
                <span>
                  {t("O menu deste número foi arquivado e não atende mais as ligações. Edite o número e escolha outro destino.")}
                </span>
              </p>
            ) : !n.menu_nome && timeArquivado(n, listaDeTimes) ? (
              <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400" data-destino-arquivado="time">
                <Warning size={14} aria-hidden className="mt-px shrink-0" />
                <span>{t("O time deste número foi arquivado e não recebe ligações. Edite o número e escolha outro time.")}</span>
              </p>
            ) : null}
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
              <Label htmlFor="tel-prefixo">{t("Prefixo de discagem (opcional)")}</Label>
              <Input
                id="tel-prefixo"
                inputMode="numeric"
                maxLength={4}
                autoComplete="off"
                value={form.prefixo}
                onChange={campo("prefixo")}
                placeholder={t("Ex.: 0")}
                aria-invalid={!prefixoOk}
                aria-describedby="tel-prefixo-ajuda"
                className="sm:max-w-[10rem]"
              />
              <p id="tel-prefixo-ajuda" className={`text-xs ${prefixoOk ? "text-muted-foreground" : "text-destructive"}`}>
                {prefixoOk
                  ? t(
                      "Algumas operadoras pedem um 0 (ou 0 + código da operadora) antes do DDD. Na dúvida, pergunte à operadora. Ex.: 0",
                    )
                  : t("Só números, de 1 a 4 dígitos.")}
              </p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="tel-destino">{t("Quando ligarem")}</Label>
              <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
                <Select value={form.destino} onValueChange={(v) => setForm((f) => ({ ...f, destino: v as Destino }))}>
                  <SelectTrigger id="tel-destino">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="time">{t("Tocar no time")}</SelectItem>
                    <SelectItem value="menu">{t("Tocar o menu")}</SelectItem>
                  </SelectContent>
                </Select>
                {form.destino === "time" ? (
                  <Select
                    value={form.time_id || SEM_TIME}
                    onValueChange={(v) => setForm((f) => ({ ...f, time_id: v === SEM_TIME ? "" : v }))}
                  >
                    <SelectTrigger id="tel-time" aria-label={t("Time que recebe as ligações")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SEM_TIME}>{t("Nenhum (só ligações de saída)")}</SelectItem>
                      {timesAtivos.map((x) => (
                        <SelectItem key={x.id} value={x.id}>
                          {x.name}
                        </SelectItem>
                      ))}
                      {atual && timeAtualForaDaLista ? (
                        // O time de agora, fora das opções: arquivado, marcado e desabilitado.
                        <SelectItem value={timeAtualForaDaLista} disabled={timeAtualArquivado}>
                          {timeAtualArquivado ? `${atual.time_nome ?? ""} — ${t("arquivado")}` : (atual.time_nome ?? "")}
                        </SelectItem>
                      ) : null}
                    </SelectContent>
                  </Select>
                ) : (
                  <Select
                    value={form.menu_id || SEM_MENU}
                    onValueChange={(v) => setForm((f) => ({ ...f, menu_id: v === SEM_MENU ? "" : v }))}
                  >
                    <SelectTrigger id="tel-menu" aria-label={t("Menu que atende as ligações")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SEM_MENU} disabled>
                        {t("Escolha o menu")}
                      </SelectItem>
                      {menus.map((m) => (
                        // Menu com a fala pendente aparece, desabilitado, com o motivo:
                        // a rota recusaria, e sumir com ele esconderia por quê.
                        <SelectItem key={m.id} value={m.id} disabled={!m.pronto}>
                          {m.pronto ? m.nome : `${m.nome} — ${t("fala pendente")}`}
                        </SelectItem>
                      ))}
                      {atual && menuAtualForaDaLista ? (
                        // O menu de agora, fora da lista dos ativos: arquivado (marcado e
                        // desabilitado), ou a lista ainda não veio.
                        <SelectItem value={menuAtualForaDaLista} disabled={atual.menu_arquivado === true}>
                          {atual.menu_arquivado ? `${atual.menu_nome ?? ""} — ${t("arquivado")}` : (atual.menu_nome ?? "")}
                        </SelectItem>
                      ) : null}
                    </SelectContent>
                  </Select>
                )}
              </div>
              {form.destino === "menu" && consultaDosMenus.isError ? (
                <p className="text-xs text-destructive">{t("Não foi possível carregar os menus. Recarregue a página.")}</p>
              ) : form.destino === "menu" && consultaDosMenus.isSuccess && menus.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("Nenhum menu criado ainda. Crie um na aba Menus.")}{" "}
                  <Link href={ABA_DOS_MENUS} className="font-medium underline underline-offset-2">
                    {t("Criar um menu")}
                  </Link>
                </p>
              ) : null}
              {bloqueioDoDestino ? (
                <p className="text-xs text-destructive" data-destino-bloqueado>
                  {bloqueioDoDestino}
                </p>
              ) : null}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("A senha fica cifrada no banco e não é mostrada de novo. Os dados de acesso são fornecidos pela sua operadora de telefonia.")}
          </p>
          {falhaAoSalvar ? (
            <p role="alert" className="text-sm text-destructive">
              {falhaAoSalvar}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button onClick={() => void salvar()} disabled={!podeSalvar || salvando}>
              {salvando ? t("Salvando…") : t("Salvar e conectar")}
            </Button>
            <Button variant="ghost" onClick={fecharFormulario} disabled={salvando}>
              {t("Cancelar")}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
