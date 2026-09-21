/**
 * UM BANCO EM MEMÓRIA QUE APLICA OS FILTROS — o dublê que se recusa a fingir.
 *
 * O dublê encadeável clássico (todo método devolve `this`, o terminal devolve o
 * que o teste mandou) prova só que o código CHAMOU a cadeia. Ele não prova que a
 * cadeia alcançou a linha certa — e foi assim que um `.neq()` contra coluna NULL
 * passou verde em `channel-ingest-zernio` com a gravação não casando nada em
 * produção (o cabeçalho daquele teste conta a história).
 *
 * Este guarda LINHAS e aplica `eq`/`is`/`in`/`gt`/`not` contra elas com a
 * semântica do SQL (comparação com NULL não casa). Um teste que passa aqui está
 * dizendo "com estes dados no banco, este código lê/grava ISTO" — que é a
 * afirmação que interessa numa rota anônima, onde filtro esquecido é vazamento.
 *
 * Cobre o subconjunto do PostgREST que `lib/channels/chat-do-site/` usa. Método
 * fora dele LANÇA em vez de virar no-op: dublê que aceita o que não entende
 * volta a ser o dublê que mente.
 */
type Linha = Record<string, unknown>;
type Predicado = (l: Linha) => boolean;

export interface ErroSimulado {
  code?: string;
  message: string;
  details?: string;
}

export class BancoEmMemoria {
  readonly tabelas = new Map<string, Linha[]>();
  /** Índices únicos simulados: tabela → lista de conjuntos de colunas. */
  readonly unicos = new Map<string, string[][]>();
  /** Todas as escritas, em ordem — para o teste conferir O QUE foi gravado. */
  readonly escritas: Array<{ tabela: string; op: "insert" | "update"; valores: Linha }> = [];
  readonly rpcs: Array<{ nome: string; args: unknown }> = [];
  readonly assinaturas: string[] = [];
  private seq = 0;

  linhas(tabela: string): Linha[] {
    if (!this.tabelas.has(tabela)) this.tabelas.set(tabela, []);
    return this.tabelas.get(tabela) as Linha[];
  }

  semear(tabela: string, ...linhas: Linha[]): this {
    this.linhas(tabela).push(...linhas.map((l) => ({ ...l })));
    return this;
  }

  unico(tabela: string, ...colunas: string[]): this {
    this.unicos.set(tabela, [...(this.unicos.get(tabela) ?? []), colunas]);
    return this;
  }

  /** O objeto com a forma do client do Supabase. */
  get cliente() {
    return {
      from: (tabela: string) => ({
        select: (colunas?: string) => new Consulta(this, tabela, "select", undefined, colunas),
        insert: (valores: Linha) => new Consulta(this, tabela, "insert", valores),
        update: (valores: Linha) => new Consulta(this, tabela, "update", valores),
      }),
      rpc: async (nome: string, args: unknown) => {
        this.rpcs.push({ nome, args });
        return { data: null, error: null };
      },
      storage: {
        from: (_bucket: string) => ({
          createSignedUrl: async (caminho: string, _validade: number) => {
            this.assinaturas.push(caminho);
            return { data: { signedUrl: `https://storage.exemplo/assinado/${caminho}?token=t` }, error: null };
          },
        }),
      },
    };
  }

  proximoId(prefixo: string): string {
    this.seq += 1;
    return `${prefixo}-${this.seq}`;
  }
}

class Consulta implements PromiseLike<{ data: unknown; error: ErroSimulado | null }> {
  private predicados: Predicado[] = [];
  private ordem: { coluna: string; asc: boolean } | null = null;
  private limite: number | null = null;
  private devolveLinhas: boolean;

  constructor(
    private banco: BancoEmMemoria,
    private tabela: string,
    private op: "select" | "insert" | "update",
    private valores?: Linha,
    _colunas?: string,
  ) {
    this.devolveLinhas = op === "select";
  }

  eq(coluna: string, valor: unknown): this {
    // SQL: `col = NULL` nunca é TRUE.
    this.predicados.push((l) => l[coluna] !== null && l[coluna] !== undefined && l[coluna] === valor);
    return this;
  }

  is(coluna: string, valor: null): this {
    if (valor !== null) throw new Error("banco-em-memoria: .is() só com null");
    this.predicados.push((l) => l[coluna] === null || l[coluna] === undefined);
    return this;
  }

  in(coluna: string, valores: unknown[]): this {
    this.predicados.push((l) => valores.includes(l[coluna]));
    return this;
  }

  gt(coluna: string, valor: string): this {
    this.predicados.push((l) => typeof l[coluna] === "string" && (l[coluna] as string) > valor);
    return this;
  }

  not(coluna: string, operador: string, valor: unknown): this {
    if (operador !== "is" || valor !== null) throw new Error("banco-em-memoria: só .not(col, 'is', null)");
    this.predicados.push((l) => l[coluna] !== null && l[coluna] !== undefined);
    return this;
  }

  order(coluna: string, opts?: { ascending?: boolean }): this {
    this.ordem = { coluna, asc: opts?.ascending !== false };
    return this;
  }

  limit(n: number): this {
    this.limite = n;
    return this;
  }

  select(_colunas?: string): this {
    this.devolveLinhas = true;
    return this;
  }

  private executar(): { data: Linha[]; error: ErroSimulado | null } {
    const linhas = this.banco.linhas(this.tabela);

    if (this.op === "insert") {
      const nova: Linha = {
        id: this.banco.proximoId(this.tabela),
        created_at: new Date(Date.UTC(2026, 8, 20, 12, 0, this.banco.linhas(this.tabela).length)).toISOString(),
        ...(this.valores ?? {}),
      };
      for (const colunas of this.banco.unicos.get(this.tabela) ?? []) {
        const colide = linhas.some((l) =>
          colunas.every((c) => nova[c] !== null && nova[c] !== undefined && l[c] === nova[c]),
        );
        if (colide) {
          return {
            data: [],
            error: {
              code: "23505",
              message: `duplicate key value violates unique constraint "uniq_${this.tabela}_${colunas.join("_")}"`,
            },
          };
        }
      }
      linhas.push(nova);
      this.banco.escritas.push({ tabela: this.tabela, op: "insert", valores: nova });
      return { data: [nova], error: null };
    }

    let alvo = linhas.filter((l) => this.predicados.every((p) => p(l)));

    if (this.op === "update") {
      for (const l of alvo) Object.assign(l, this.valores);
      if (alvo.length > 0) {
        this.banco.escritas.push({ tabela: this.tabela, op: "update", valores: { ...(this.valores ?? {}) } });
      }
      return { data: alvo, error: null };
    }

    if (this.ordem) {
      const { coluna, asc } = this.ordem;
      alvo = [...alvo].sort((a, b) => {
        const x = String(a[coluna] ?? "");
        const y = String(b[coluna] ?? "");
        return asc ? x.localeCompare(y) : y.localeCompare(x);
      });
    }
    if (this.limite !== null) alvo = alvo.slice(0, this.limite);
    return { data: alvo, error: null };
  }

  async maybeSingle(): Promise<{ data: Linha | null; error: ErroSimulado | null }> {
    const r = this.executar();
    if (r.error) return { data: null, error: r.error };
    if (r.data.length > 1) {
      // O desfecho real do PostgREST — e o modo de falha da issue #236.
      return { data: null, error: { code: "PGRST116", message: "multiple rows returned" } };
    }
    return { data: r.data[0] ?? null, error: null };
  }

  async single(): Promise<{ data: Linha | null; error: ErroSimulado | null }> {
    const r = await this.maybeSingle();
    if (!r.error && !r.data) return { data: null, error: { code: "PGRST116", message: "no rows returned" } };
    return r;
  }

  then<A = { data: unknown; error: ErroSimulado | null }, B = never>(
    resolvido?: ((v: { data: unknown; error: ErroSimulado | null }) => A | PromiseLike<A>) | null,
    rejeitado?: ((motivo: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    const r = this.executar();
    const valor = { data: this.devolveLinhas ? r.data : null, error: r.error };
    return Promise.resolve(valor).then(resolvido, rejeitado);
  }
}
