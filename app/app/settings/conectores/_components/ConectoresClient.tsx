"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import type { ConexaoPublica } from "@/lib/conectores/conexao";
import { FRASE_DA_FALHA, type MotivoDeFalha } from "@/lib/conectores/tipos";
import { CheckCircle, CircleNotch, PlugsConnected, Warning } from "@/lib/ui/icons";

/**
 * A tela de Conectores. Uma ficha por conector do registro; cada ficha tem três
 * estados que a pessoa precisa distinguir de relance: DESLIGADO (formulário),
 * LIGADO e funcionando, e LIGADO com erro — que é o que o painel do atendente
 * carimba quando o ERP recusa o token, para o admin ver aqui o que o atendente
 * viu lá.
 *
 * O token nunca volta: a ficha mostra só os 4 últimos caracteres.
 */
interface ConectorDaTela {
  id: string;
  rotulo: string;
  descricao: string;
  ajuda_do_endereco: string;
  ajuda_do_token: string;
  conexao: ConexaoPublica | null;
}

const PRAZO_DO_TESTE_MS = 30_000;
const CHAVE = ["conectores", "configuracao"] as const;

function mensagemDoErro(err: unknown, padrao: string): string {
  return err instanceof ApiError && err.message ? err.message : padrao;
}

function Ficha({ conector }: { conector: ConectorDaTela }) {
  const t = useT();
  const qc = useQueryClient();
  const [editando, setEditando] = useState(false);
  const [endereco, setEndereco] = useState(conector.conexao?.base_url ?? "");
  const [token, setToken] = useState("");
  const [confirmandoDesligar, setConfirmandoDesligar] = useState(false);

  const recarregar = () => {
    void qc.invalidateQueries({ queryKey: CHAVE });
    // O trilho do inbox pergunta quais conectores estão ligados: ligar aqui tem
    // de fazer a aba aparecer lá sem recarregar a página.
    void qc.invalidateQueries({ queryKey: ["conectores", "ativos"] });
  };

  const salvar = useMutation({
    mutationFn: () =>
      apiClient.put(
        `/api/v1/conectores/${conector.id}/conexao`,
        { base_url: endereco, ...(token ? { token } : {}) },
        { timeoutMs: PRAZO_DO_TESTE_MS },
      ),
    onSuccess: () => {
      toast.success(t("Conexão testada e salva."));
      setToken("");
      setEditando(false);
      recarregar();
    },
    onError: (err) => toast.error(mensagemDoErro(err, t("Não consegui salvar a conexão."))),
  });

  const testar = useMutation({
    mutationFn: () =>
      apiClient.post<{ data: { funcionou: boolean; mensagem: string } }>(
        `/api/v1/conectores/${conector.id}/conexao/testar`,
        {},
        { timeoutMs: PRAZO_DO_TESTE_MS },
      ),
    onSuccess: (res) => {
      if (res.data.funcionou) toast.success(res.data.mensagem);
      else toast.error(res.data.mensagem);
      recarregar();
    },
    onError: (err) => toast.error(mensagemDoErro(err, t("Não consegui testar a conexão."))),
  });

  const desligar = useMutation({
    mutationFn: () => apiClient.delete(`/api/v1/conectores/${conector.id}/conexao`),
    onSuccess: () => {
      toast.success(t("Conector desligado."));
      setConfirmandoDesligar(false);
      setEndereco("");
      recarregar();
    },
    onError: (err) => toast.error(mensagemDoErro(err, t("Não consegui desligar o conector."))),
  });

  const conexao = conector.conexao;
  const mostrarFormulario = !conexao || editando;
  const comErro = conexao?.status === "erro";

  return (
    <section
      className="max-w-2xl rounded-lg border border-border bg-surface p-5"
      data-testid={`conector-${conector.id}`}
      data-estado={!conexao ? "desligado" : comErro ? "erro" : "ligado"}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-elevated text-text-muted">
          <PlugsConnected size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-text">{conector.rotulo}</h2>
            {conexao && !comErro && (
              <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-xs font-medium text-success-fg">
                <CheckCircle size={12} aria-hidden />
                {t("Ligado")}
              </span>
            )}
            {comErro && (
              <span className="inline-flex items-center gap-1 rounded-full bg-error-bg px-2 py-0.5 text-xs font-medium text-error-fg">
                <Warning size={12} aria-hidden />
                {t("Com problema")}
              </span>
            )}
            {!conexao && (
              <span className="rounded-full bg-surface-elevated px-2 py-0.5 text-xs font-medium text-text-muted">
                {t("Desligado")}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-text-muted">{t(conector.descricao)}</p>
        </div>
      </div>

      {comErro && (
        <p className="mt-4 rounded-md bg-error-bg px-3 py-2 text-sm text-error-fg" data-testid="conector-erro">
          {t(FRASE_DA_FALHA[(conexao?.status_detalhe ?? "") as MotivoDeFalha] ?? "A última consulta a este sistema falhou.")}{" "}
          {t("Enquanto isso, o painel do atendimento não mostra os dados.")}
        </p>
      )}

      {conexao && !editando && (
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
          <dt className="text-text-muted">{t("Endereço")}</dt>
          <dd className="min-w-0 break-all text-text">{conexao.base_url}</dd>
          <dt className="text-text-muted">{t("Token")}</dt>
          <dd className="font-mono text-text">••••{conexao.token_last4}</dd>
          {conexao.verificada_em && (
            <>
              <dt className="text-text-muted">{t("Último teste")}</dt>
              <dd className="tabular-nums text-text">{new Date(conexao.verificada_em).toLocaleString("pt-BR")}</dd>
            </>
          )}
        </dl>
      )}

      {mostrarFormulario && (
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            salvar.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`endereco-${conector.id}`}>{t("Endereço do sistema")}</Label>
            <Input
              id={`endereco-${conector.id}`}
              value={endereco}
              onChange={(e) => setEndereco(e.target.value)}
              placeholder="https://"
              autoComplete="off"
              required
            />
            <p className="text-xs text-text-muted">{t(conector.ajuda_do_endereco)}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`token-${conector.id}`}>{t("Token de acesso")}</Label>
            <Input
              id={`token-${conector.id}`}
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={conexao ? t("Deixe em branco para manter o token atual") : ""}
              autoComplete="off"
              required={!conexao}
            />
            <p className="text-xs text-text-muted">{t(conector.ajuda_do_token)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={salvar.isPending}>
              {salvar.isPending && <CircleNotch size={14} className="mr-1.5 animate-spin" aria-hidden />}
              {salvar.isPending ? t("Testando…") : t("Testar e salvar")}
            </Button>
            {conexao && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditando(false);
                  setToken("");
                  setEndereco(conexao.base_url);
                }}
              >
                {t("Cancelar")}
              </Button>
            )}
          </div>
          <p className="text-xs text-text-muted">
            {t("O token é testado antes de ser salvo, fica cifrado e nunca volta a aparecer nesta tela.")}
          </p>
        </form>
      )}

      {conexao && !editando && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => testar.mutate()} disabled={testar.isPending}>
            {testar.isPending && <CircleNotch size={14} className="mr-1.5 animate-spin" aria-hidden />}
            {t("Testar conexão")}
          </Button>
          <Button variant="outline" onClick={() => setEditando(true)}>
            {t("Trocar endereço ou token")}
          </Button>
          {confirmandoDesligar ? (
            <>
              <Button variant="destructive" onClick={() => desligar.mutate()} disabled={desligar.isPending}>
                {t("Confirmar: desligar")}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmandoDesligar(false)}>
                {t("Cancelar")}
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmandoDesligar(true)}>
              {t("Desligar")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function ConectoresClient() {
  const t = useT();
  const lista = useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<{ data: ConectorDaTela[] }>("/api/v1/conectores")).data,
    staleTime: 10_000,
  });

  if (lista.isLoading) return <Skeleton className="h-40 max-w-2xl" />;
  if (lista.isError || !lista.data) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-error-fg">{t("Não consegui ler os conectores.")}</p>
        <Button variant="outline" onClick={() => lista.refetch()}>
          {t("Tentar de novo")}
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {lista.data.map((c) => (
        <Ficha key={c.id} conector={c} />
      ))}
    </div>
  );
}
