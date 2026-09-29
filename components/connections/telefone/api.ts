"use client";
/**
 * O acesso das abas Menus e Voz e falas (Conexões › Telefone) às rotas
 * `/api/v1/telefonia/...`. Toda leitura passa pela API: no navegador o cliente do
 * Supabase consultaria como ANÔNIMO (o cookie é httpOnly) e voltaria vazio, sem
 * erro nenhum — a tela mostraria "nenhuma fala" para quem tem falas.
 *
 * As chaves de cache moram aqui e SÓ aqui: quem precisa reler a aba (o cartão da
 * ElevenLabs em Credenciais de IA, depois de salvar a chave) importa a constante.
 * Uma cópia escrita à mão em outro arquivo deixa de reler no dia em que a chave
 * mudar — e ninguém percebe, porque nada quebra.
 */
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { FalaGeral, FalaPublica, MenuPublico } from "@/lib/telefonia/vocabulario";

/** `GET /api/v1/telefonia/voz` (admin). */
export interface VozDoTelefone {
  /** A telefonia está ligada nesta instalação (o ARI está configurado). */
  oferecida: boolean;
  chave: { cadastrada: boolean; last4: string | null };
  voz: { voice_id: string; model_id: string } | null;
  falas: Record<FalaGeral, FalaPublica | null>;
}

/** Uma voz da conta da ElevenLabs, como `GET /api/v1/telefonia/voz/vozes` a devolve. */
export interface VozDaConta {
  voice_id: string;
  nome: string;
  categoria: string | null;
  /** Amostra pública (só `https:`), para o "Ouvir amostra". */
  amostra_url: string | null;
}

/** A resposta do "Salvar e usar" de uma fala geral. Falha volta como erro (409/422/502), nunca aqui. */
export interface RespostaDaFala {
  fala: FalaPublica;
}

/** `GET /api/v1/telefonia/menus` (admin). */
export interface RespostaDosMenus {
  oferecida: boolean;
  menus: MenuPublico[];
}

export interface RespostaDoMenu {
  menu: MenuPublico | null;
}

export const CHAVE_DA_VOZ = ["telefonia", "voz"] as const;
export const CHAVE_DAS_VOZES = ["telefonia", "vozes"] as const;
export const CHAVE_DOS_MENUS = ["telefonia", "menus"] as const;

export function useVozDoTelefone() {
  return useQuery({
    queryKey: CHAVE_DA_VOZ,
    queryFn: async () => (await apiClient.get<{ data: VozDoTelefone }>("/api/v1/telefonia/voz")).data,
  });
}

/**
 * Vozes da conta da ElevenLabs — só com a chave cadastrada (sem ela a rota
 * responde 422). Listar não sintetiza nada e não gasta crédito.
 */
export function useVozesDaConta(ligado: boolean) {
  return useQuery({
    queryKey: CHAVE_DAS_VOZES,
    enabled: ligado,
    staleTime: 5 * 60_000,
    queryFn: async () =>
      (await apiClient.get<{ data: { vozes: VozDaConta[] } }>("/api/v1/telefonia/voz/vozes")).data.vozes,
  });
}

export function useMenusDoTelefone() {
  return useQuery({
    queryKey: CHAVE_DOS_MENUS,
    queryFn: async () => (await apiClient.get<{ data: RespostaDosMenus }>("/api/v1/telefonia/menus")).data,
  });
}
