"use client";
/**
 * Conexões › Telefone › Ramais (v3; desenho §12.5, D11, D18, D22) — só admin.
 *
 * Cada pessoa com papel de atendimento tem um ramal, dado sozinho a partir de
 * 201 quando ela ganha o papel (e liberado quando perde). Aqui o admin vê todos,
 * com os times e a situação de agora (relida a cada 10 s), e troca o número:
 * 2 a 4 dígitos, sem começar por 0, único na organização.
 */
import { useCallback, useEffect, useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ROTULO_DA_SITUACAO, type ColegaDoDiretorio } from "@/components/telefonia/useDiretorio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { trocarMarcador } from "@/lib/telefonia/texto-do-menu";
import { REGUA_DO_RAMAL } from "@/lib/telefonia/vocabulario";

const RELER_MS = 10_000;

const COR_DA_SITUACAO: Record<ColegaDoDiretorio["situacao"], string> = {
  disponivel: "bg-emerald-500",
  em_ligacao: "bg-sky-500",
  em_pausa: "bg-amber-400",
  fora_do_horario: "bg-muted-foreground/50",
  offline: "bg-muted-foreground/30",
};

function LinhaDoRamal({ p, aoSalvar }: { p: ColegaDoDiretorio; aoSalvar: () => void }) {
  const t = useT();
  // `null` = ninguém está editando: a linha mostra o que o servidor diz (outra aba,
  // ou o gatilho, pode ter trocado o número); o texto digitado só existe na edição.
  const [rascunho, setRascunho] = useState<string | null>(null);
  const numero = rascunho ?? p.ramal ?? "";
  const [salvando, setSalvando] = useState(false);
  const valido = REGUA_DO_RAMAL.test(numero);
  const mudou = numero !== (p.ramal ?? "");

  const salvar = async () => {
    if (!valido || !mudou) return;
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/telefonia/ramais/${p.user_id}`, { numero });
      setRascunho(null);
      aoSalvar();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  };

  return (
    <tr className="border-b border-border last:border-0" data-ramal-de={p.user_id}>
      <td className="py-2 pr-3 text-sm font-medium">{p.nome}</td>
      <td className="py-2 pr-3">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void salvar();
          }}
        >
          <Input
            value={numero}
            inputMode="numeric"
            maxLength={4}
            onChange={(e) => setRascunho(e.target.value.replace(/\D/g, ""))}
            aria-label={trocarMarcador(t("Ramal de {nome}"), "{nome}", p.nome)}
            aria-invalid={!valido}
            className="h-8 w-20 tabular-nums"
          />
          {mudou ? (
            <Button type="submit" size="sm" className="h-8" disabled={!valido || salvando}>
              {t("Salvar")}
            </Button>
          ) : null}
        </form>
        {mudou && !valido ? <p className="mt-1 text-xs text-destructive">{t("O ramal tem de 2 a 4 dígitos e não começa por 0.")}</p> : null}
      </td>
      <td className="py-2 pr-3 text-sm text-muted-foreground">{p.times.map((x) => x.nome).join(", ") || "—"}</td>
      <td className="py-2 text-sm">
        <span className="inline-flex items-center gap-1.5" data-situacao={p.situacao}>
          <span aria-hidden className={`h-2 w-2 rounded-full ${COR_DA_SITUACAO[p.situacao]}`} />
          {t(ROTULO_DA_SITUACAO[p.situacao])}
        </span>
      </td>
    </tr>
  );
}

export function RamaisDoTelefone() {
  const t = useT();
  const [pessoas, setPessoas] = useState<ColegaDoDiretorio[] | null>(null);
  const [erro, setErro] = useState(false);
  // Muda depois de salvar: relê na hora, sem esperar os 10 s.
  const [leitura, setLeitura] = useState(0);

  useEffect(() => {
    let vivo = true;
    const ler = () =>
      apiClient
        .get<{ data: { pessoas: ColegaDoDiretorio[] } }>("/api/v1/telefonia/ramais")
        .then((r) => {
          if (!vivo) return;
          setPessoas(r.data.pessoas);
          setErro(false);
        })
        .catch(() => vivo && setErro(true));
    void ler();
    const i = setInterval(() => void ler(), RELER_MS);
    return () => {
      vivo = false;
      clearInterval(i);
    };
  }, [leitura]);
  const reler = useCallback(() => setLeitura((n) => n + 1), []);

  return (
    <section className="space-y-3" data-telefonia-ramais>
      <div>
        <h2 className="text-base font-semibold">{t("Ramais")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Cada pessoa que atende ganha um ramal sozinha, a partir de 201. Os colegas ligam uns para os outros discando o ramal no telefone do cabeçalho, e o cliente pode digitá-lo no menu que aceita ramal.",
          )}
        </p>
      </div>
      {erro && !pessoas ? <p className="text-sm text-muted-foreground">{t("Só quem administra a organização vê os ramais.")}</p> : null}
      {pessoas && pessoas.length === 0 ? <p className="text-sm text-muted-foreground">{t("Ninguém atende o telefone ainda.")}</p> : null}
      {pessoas && pessoas.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[520px] text-left">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-0 py-2 pl-3 font-medium">{t("Pessoa")}</th>
                <th className="py-2 font-medium">{t("Ramal")}</th>
                <th className="py-2 font-medium">{t("Times")}</th>
                <th className="py-2 pr-3 font-medium">{t("Situação")}</th>
              </tr>
            </thead>
            <tbody className="[&_td:first-child]:pl-3 [&_td:last-child]:pr-3">
              {pessoas.map((p) => (
                <LinhaDoRamal key={p.user_id} p={p} aoSalvar={reler} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
