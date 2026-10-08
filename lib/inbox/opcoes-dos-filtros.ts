/**
 * O que o painel de filtros do Inbox precisa para montar os seletores de
 * atendente, caixa de entrada e assunto — a resposta de
 * `GET /api/v1/conversations/filtros`.
 *
 * Só TIPOS, e num arquivo sem dependência de servidor: a tela importa daqui, e
 * importar do `_handler` da rota arrastaria o client de service role para o
 * bundle do navegador.
 */
import type { MeioDeCanal } from "@/lib/channels/capabilities";

export interface AtendenteDoFiltro {
  user_id: string;
  /**
   * `null` quando o nome não pôde ser lido (self-host sem service role, ou o
   * lookup falhou). Não quer dizer "sem nome": a tela cai no rótulo genérico.
   */
  nome: string | null;
  /** `false` para quem saiu da organização — e ainda é dono de histórico. */
  ativo: boolean;
}

/** Um número, widget ou tronco por onde a conversa chega — com o MEIO, nunca o provider. */
export interface CaixaDeEntrada {
  id: string;
  meio: MeioDeCanal;
  nome: string | null;
  numero: string | null;
}

export interface AssuntosDoTime {
  time_id: string;
  time: string;
  /** Arquivado continua na lista: ele ainda nomeia atendimentos antigos. */
  assuntos: Array<{ id: string; nome: string; arquivado: boolean }>;
}

export interface OpcoesDosFiltros {
  /** Vazio para quem não enxerga conversa de colega (`podeVerColegas`). */
  atendentes: AtendenteDoFiltro[];
  caixas: CaixaDeEntrada[];
  assuntos: AssuntosDoTime[];
}
