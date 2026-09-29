export interface ApiSuccess<T> {
  data: T;
  meta?: { cursor?: string; has_more?: boolean; total?: number; request_id?: string };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    request_id?: string;
  };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details: Record<string, unknown> | undefined,
    public readonly requestId: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

/**
 * Um `ApiError` cuja resposta NÃO trouxe o corpo estruturado
 * (`{ error: { code, message } }`): o 504 de um proxy com HTML, um 502 vazio,
 * "Bad Gateway". O código foi sintetizado pelo status e a mensagem é o texto
 * cru da resposta, ou `HTTP <status>` — nada disso é frase para o usuário.
 *
 * Subclasse, e não um campo novo em `ApiError`: quem já checa `instanceof
 * ApiError`, lê `code`/`message`/`status` ou compara `name` continua vendo
 * exatamente o que via (o `name` segue "ApiError"). Só quem quer saber de quem
 * é a mensagem pergunta — por `mensagemDoServidor`.
 */
export class ApiErrorSemCorpo extends ApiError {}

/**
 * A frase do SERVIDOR num erro da API, ou `null`: `null` quando o erro não é da
 * API, quando a resposta não trouxe corpo estruturado (a mensagem foi inventada
 * pelo cliente — ver `ApiErrorSemCorpo`), ou quando o corpo veio sem mensagem (o
 * `ApiError` usa o próprio código como mensagem, e código não é frase). Quem
 * mostra erro na tela usa isto antes de cair na frase genérica do próprio gesto.
 */
export function mensagemDoServidor(erro: unknown): string | null {
  if (!(erro instanceof ApiError) || erro instanceof ApiErrorSemCorpo) return null;
  const frase = erro.message.trim();
  return frase && erro.message !== erro.code ? erro.message : null;
}
