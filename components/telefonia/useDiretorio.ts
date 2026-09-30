"use client";
/**
 * O DIRETÓRIO DO TELEFONE na tela (v2/v3): quem pode receber uma transferência
 * ou uma ligação interna agora, e os times. Lido quando `ativo` liga e relido a
 * cada 5 s enquanto fica ligado — a situação de um colega muda no meio (pausa,
 * outra ligação), e a régua de D17 é a de agora.
 */
import { useEffect, useState } from "react";

import { apiClient } from "@/lib/api/client";

export type SituacaoDoColega = "disponivel" | "em_ligacao" | "em_pausa" | "fora_do_horario" | "offline";

export interface ColegaDoDiretorio {
  user_id: string;
  nome: string;
  ramal: string | null;
  situacao: SituacaoDoColega;
  times: Array<{ id: string; nome: string }>;
  eu: boolean;
}

export interface TimeDoDiretorio {
  id: string;
  nome: string;
  disponiveis: number;
  situacao: "aberto" | "fora_do_horario";
}

export interface DiretorioDoTelefone {
  meu_ramal: string | null;
  pessoas: ColegaDoDiretorio[];
  times: TimeDoDiretorio[];
}

export const RELER_DIRETORIO_MS = 5_000;

/** O que a tela diz de cada situação. Em português; a tela passa por `t()`. */
export const ROTULO_DA_SITUACAO: Record<SituacaoDoColega, string> = {
  disponivel: "Disponível",
  em_ligacao: "Em ligação",
  em_pausa: "Em pausa",
  fora_do_horario: "Fora do horário",
  offline: "Offline",
};

export function useDiretorio(ativo: boolean): { diretorio: DiretorioDoTelefone | null; carregando: boolean } {
  const [diretorio, setDiretorio] = useState<DiretorioDoTelefone | null>(null);
  const [carregando, setCarregando] = useState(false);
  useEffect(() => {
    if (!ativo) return;
    let vivo = true;
    const ler = async () => {
      try {
        const r = await apiClient.get<{ data: DiretorioDoTelefone }>("/api/v1/telefonia/diretorio");
        if (vivo) setDiretorio(r.data);
      } catch {
        /* a próxima leitura tenta de novo */
      } finally {
        if (vivo) setCarregando(false);
      }
    };
    setCarregando(true);
    void ler();
    const t = setInterval(ler, RELER_DIRETORIO_MS);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [ativo]);
  return { diretorio, carregando };
}

/** Sem acento e em minúsculas — a busca por "joao" acha "João". */
export function normalizarBusca(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** A pessoa casa com a busca pelo nome ou pelo começo do ramal. */
export function casaComABusca(p: { nome: string; ramal: string | null }, busca: string): boolean {
  const b = normalizarBusca(busca);
  if (!b) return true;
  if (/^\d+$/.test(b)) return (p.ramal ?? "").startsWith(b);
  return normalizarBusca(p.nome).includes(b);
}
