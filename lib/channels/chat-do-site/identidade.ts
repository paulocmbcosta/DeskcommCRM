/**
 * Os dois segredos do chat do site — e por que nenhum deles é um JWT.
 *
 * ─── A chave do WIDGET (pública) ────────────────────────────────────────────
 *
 * Vai em HTML aberto: `<script data-widget-key="wc_…">`. Não autentica ninguém;
 * só diz DE QUEM é o widget, e é dela que a rota pública tira a organização —
 * fonte confiável do tenant, nunca o corpo do pedido (CLAUDE.md,
 * multi-tenancy). 24 caracteres de CSPRNG não são para esconder a chave, são
 * para que ninguém ENUMERE widgets alheios chutando valores.
 *
 * ─── O token do VISITANTE (segredo) ─────────────────────────────────────────
 *
 * Quem tem o token lê a conversa. Ele nasce no servidor, vai UMA vez ao
 * navegador na resposta da primeira mensagem, e o banco guarda só o SHA-256 em
 * `conversations.provider_conversation_id` — a mesma regra do bearer token da
 * API (anti-pattern 13: plaintext de credencial nunca no banco). Um dump do
 * banco não abre a conversa de ninguém.
 *
 * Por que não JWT assinado: exigiria um segredo de instalação novo, e env var
 * nova sem default quebra a instalação fresca e a VPS que atualiza sem editar
 * `.env` (doutrina de packaging). Token opaco com hash no banco não pede nada
 * a ninguém, e revogar é apagar a linha.
 *
 * 32 bytes de CSPRNG = 256 bits: SHA-256 SEM sal é suficiente aqui. Sal existe
 * para proteger segredo de baixa entropia (senha) contra dicionário; contra
 * 2^256 não há dicionário, e o hash precisa ser determinístico porque é a
 * CHAVE DE BUSCA da conversa.
 */
import { createHash, randomBytes } from "node:crypto";

const PREFIXO_DA_CHAVE = "wc_";
const PREFIXO_DO_TOKEN = "wv_";
/** O que vai para `provider_conversation_id`: deixa claro, no dado, de que espaço é o id. */
const PREFIXO_DA_THREAD = "wv:";

const ALFABETO = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** `wc_` + 24 caracteres alfanuméricos. Sem viés: rejeita o byte fora do múltiplo. */
export function gerarChaveDoWidget(): string {
  const teto = 256 - (256 % ALFABETO.length);
  let saida = "";
  while (saida.length < 24) {
    for (const byte of randomBytes(32)) {
      if (byte >= teto) continue;
      saida += ALFABETO[byte % ALFABETO.length];
      if (saida.length === 24) break;
    }
  }
  return `${PREFIXO_DA_CHAVE}${saida}`;
}

const FORMA_DA_CHAVE = /^wc_[a-zA-Z0-9]{24}$/;

/**
 * A chave tem a forma que NÓS geramos? Perguntado antes de ir ao banco: uma
 * rota pública recebe lixo o dia inteiro, e consultar `channel_sessions` para
 * cada `../../etc/passwd` é dar ao atacante uma consulta grátis por pedido.
 */
export function chaveDoWidgetTemForma(valor: string | null | undefined): valor is string {
  return typeof valor === "string" && FORMA_DA_CHAVE.test(valor);
}

/** `wv_` + 32 bytes em base64url (43 caracteres). */
export function gerarTokenDoVisitante(): string {
  return `${PREFIXO_DO_TOKEN}${randomBytes(32).toString("base64url")}`;
}

const FORMA_DO_TOKEN = /^wv_[A-Za-z0-9_-]{43}$/;

export function tokenDoVisitanteTemForma(valor: string | null | undefined): valor is string {
  return typeof valor === "string" && FORMA_DO_TOKEN.test(valor);
}

/**
 * Token → o valor que mora em `conversations.provider_conversation_id`.
 *
 * Determinístico de propósito: é a chave de busca. Quem compara é o índice do
 * Postgres sobre o HASH (256 bits de saída de SHA-256), então não há comparação
 * de segredo em tempo variável para explorar — o atacante que mede tempo
 * aprende sobre o hash, não sobre o token.
 */
export function threadDoVisitante(token: string): string {
  return `${PREFIXO_DA_THREAD}${createHash("sha256").update(token).digest("hex")}`;
}
