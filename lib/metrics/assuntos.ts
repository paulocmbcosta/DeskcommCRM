/**
 * OS NÚMEROS POR ASSUNTO (migration 0293) — do que os atendimentos encerrados
 * num período trataram.
 *
 * `fn_metricas_de_assuntos` devolve uma linha por par (assunto, time que
 * atendeu). Esta função pura a transforma no que a tela mostra: os setores, os
 * assuntos de cada um, quantos ficaram sem assunto e quantos foram atendidos
 * por um time DIFERENTE do setor do assunto.
 *
 * Esse último número é o laço de retorno da feature: assunto de Cobrança
 * atendido pelo Comercial quer dizer que o cliente chegou ao time errado.
 * "Sem time" não entra nele — atendimento sem time não foi mal encaminhado,
 * só não foi encaminhado.
 */

/** Uma linha de `fn_metricas_de_assuntos`. */
export interface LinhaDeAssunto {
  assunto_id: string | null;
  assunto_nome: string | null;
  assunto_team_id: string | null;
  assunto_team_nome: string | null;
  atendimento_team_id: string | null;
  atendimento_team_nome: string | null;
  total: number | string;
}

export interface AssuntoContado {
  id: string;
  nome: string;
  total: number;
  /** Dos `total`, quantos foram atendidos por outro time que não o setor do assunto. */
  de_outro_time: number;
}

export interface SetorContado {
  id: string | null;
  nome: string | null;
  total: number;
  assuntos: AssuntoContado[];
}

export interface AssuntosDoPeriodo {
  /** Todos os atendimentos encerrados no período. */
  total: number;
  com_assunto: number;
  sem_assunto: number;
  /** Os sem assunto, pelo time que atendeu (`id` nulo = sem time). */
  sem_assunto_por_time: { id: string | null; nome: string | null; total: number }[];
  setores: SetorContado[];
}

const porTotalDepoisNome = <T extends { total: number; nome: string | null }>(a: T, b: T) =>
  b.total - a.total || (a.nome ?? "").localeCompare(b.nome ?? "", "pt-BR");

export function agruparAssuntos(linhas: readonly LinhaDeAssunto[]): AssuntosDoPeriodo {
  const setores = new Map<string, SetorContado & { porAssunto: Map<string, AssuntoContado> }>();
  const semAssunto = new Map<string, { id: string | null; nome: string | null; total: number }>();
  let total = 0;
  let comAssunto = 0;

  for (const linha of linhas) {
    const n = Number(linha.total);
    if (!Number.isFinite(n) || n <= 0) continue;
    total += n;

    if (linha.assunto_id === null) {
      const chave = linha.atendimento_team_id ?? "";
      const atual = semAssunto.get(chave) ?? {
        id: linha.atendimento_team_id,
        nome: linha.atendimento_team_nome,
        total: 0,
      };
      atual.total += n;
      semAssunto.set(chave, atual);
      continue;
    }

    comAssunto += n;
    const chaveDoSetor = linha.assunto_team_id ?? "";
    const setor = setores.get(chaveDoSetor) ?? {
      id: linha.assunto_team_id,
      nome: linha.assunto_team_nome,
      total: 0,
      assuntos: [],
      porAssunto: new Map<string, AssuntoContado>(),
    };
    setor.total += n;
    const assunto = setor.porAssunto.get(linha.assunto_id) ?? {
      id: linha.assunto_id,
      nome: linha.assunto_nome ?? "",
      total: 0,
      de_outro_time: 0,
    };
    assunto.total += n;
    if (linha.atendimento_team_id !== null && linha.atendimento_team_id !== linha.assunto_team_id) {
      assunto.de_outro_time += n;
    }
    setor.porAssunto.set(linha.assunto_id, assunto);
    setores.set(chaveDoSetor, setor);
  }

  return {
    total,
    com_assunto: comAssunto,
    sem_assunto: total - comAssunto,
    sem_assunto_por_time: [...semAssunto.values()].sort(porTotalDepoisNome),
    setores: [...setores.values()]
      .map(({ porAssunto, ...setor }) => ({ ...setor, assuntos: [...porAssunto.values()].sort(porTotalDepoisNome) }))
      .sort(porTotalDepoisNome),
  };
}

/** Percentual inteiro de `parte` em `todo`; 0 quando não há todo. */
export function percentual(parte: number, todo: number): number {
  return todo > 0 ? Math.round((parte / todo) * 100) : 0;
}
