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

/**
 * `ligado = false` não busca: a aba Números só precisa da lista quando o
 * formulário de um número está aberto — a leitura dos menus soma o "últimos 7
 * dias" de cada um, e o cartão do número não depende dela.
 *
 * `releAoVoltar` relê SEMPRE que a janela volta a ter foco — o cliente da
 * aplicação desliga isso por padrão (`lib/query/client.ts`). É para quem manda a
 * pessoa criar o menu em outra aba e espera vê-lo ao voltar. A opção só entra no
 * objeto quando pedida: um `undefined` explícito sobrescreveria o padrão.
 */
export function useMenusDoTelefone(ligado = true, { releAoVoltar = false }: { releAoVoltar?: boolean } = {}) {
  return useQuery({
    queryKey: CHAVE_DOS_MENUS,
    enabled: ligado,
    ...(releAoVoltar ? { refetchOnWindowFocus: "always" as const } : {}),
    queryFn: async () => (await apiClient.get<{ data: RespostaDosMenus }>("/api/v1/telefonia/menus")).data,
  });
}

/** `GET /api/v1/telefonia/gravacao` (admin) — a política de gravação das ligações (F3). */
export interface GravacaoDoTelefone {
  oferecida: boolean;
  ativa: boolean;
  retencao_dias: number;
  /** As retenções que a rota aceita (`RETENCOES_DA_GRAVACAO_DIAS`). */
  retencoes: number[];
  /** O aviso de gravação configurado (pronto ou não). Sem ele pronto, a gravação não liga. */
  aviso: FalaPublica | null;
}

export const CHAVE_DA_GRAVACAO = ["telefonia", "gravacao"] as const;

export function useGravacaoDoTelefone() {
  return useQuery({
    queryKey: CHAVE_DA_GRAVACAO,
    queryFn: async () => (await apiClient.get<{ data: GravacaoDoTelefone }>("/api/v1/telefonia/gravacao")).data,
  });
}
