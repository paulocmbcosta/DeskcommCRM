/**
 * As regras de uma conta SIP — servidor e usuário — num lugar só, e puras.
 *
 * Existem DUAS portas por onde um valor chega ao Asterisk, e as duas precisam
 * da mesma régua:
 *
 *   1. a rota da tela (`numeroSchema`, em `numeros.ts`), que valida com Zod;
 *   2. a linha de `channel_sessions`, que o worker lê e empurra pela ARI
 *      (`problemaDoTronco`, em `pjsip.ts`). Um admin grava nessa tabela direto
 *      pela REST, sem passar pelo Zod da rota — e o que estiver lá vira campo
 *      de objeto PJSIP. Uma vírgula em `sip_server`, por exemplo, vira um
 *      segundo contato na AOR (o campo `contact` é uma lista separada por
 *      vírgula), e o Asterisk passa a mandar OPTIONS para onde a vírgula mandar.
 *
 * Com duas cópias da regra, a segunda diverge na primeira edição. Por isso a
 * rota e o worker importam daqui.
 */

/** Host ou IP, sem esquema, porta nem caminho — o que a operadora entrega como "servidor". */
const HOST = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * Um rótulo que só um IP escreveria: decimal, octal com zero à esquerda ou
 * hexadecimal. Nenhum domínio de verdade termina num rótulo assim (não existe
 * TLD numérico), então o host que termina nele É um IP — e tem de estar na
 * grafia canônica. Sem isto, `0x7f.1` e `0177.0.0.1` passariam pela régua das
 * faixas abaixo e o resolvedor do Asterisk (`inet_aton`) os leria como
 * 127.0.0.1.
 */
const ROTULO_DE_IP = /^(0x[0-9a-f]*|[0-9]+)$/i;

/** Quatro octetos decimais, 0–255, sem zero à esquerda. */
function octetosCanonicos(host: string): number[] | null {
  const partes = host.split(".");
  if (partes.length !== 4) return null;
  const octetos: number[] = [];
  for (const p of partes) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octetos.push(n);
  }
  return octetos;
}

/**
 * Faixas que nunca são a operadora: é a rede do próprio servidor. O Asterisk
 * roda na rede interna do compose, ao lado do Redis, do app e da ARI; um
 * "servidor SIP" apontado para lá faz o PABX mandar REGISTER e OPTIONS a cada
 * 25 s para dentro da instalação, na porta que o admin escolher.
 */
function ipInterno([a, b]: number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8 — "este host"
    a === 127 || // loopback
    a === 10 || // 10/8
    (a === 172 && b! >= 16 && b! <= 31) || // 172.16/12 — onde o Docker cria as redes
    (a === 192 && b === 168) || // 192.168/16
    (a === 169 && b === 254) // link-local — inclui o 169.254.169.254 dos metadados da nuvem
  );
}

export type MotivoDoServidor = "formato" | "interno";

/**
 * `null` quando o servidor serve; senão, o motivo. Recebe o host já sem
 * esquema e sem porta (a rota normaliza antes; o worker lê a coluna crua, e
 * uma coluna com `sip:` ou `:5060` é recusada como formato).
 */
export function motivoDoServidorInvalido(bruto: string): MotivoDoServidor | null {
  const host = bruto.toLowerCase();
  if (!HOST.test(host)) return "formato";
  const rotulos = host.split(".");
  // Nome de um rótulo só (`asterisk`, `redis`, `app`, `localhost`) é nome de
  // serviço da rede interna do Docker, não de operadora.
  if (rotulos.length < 2) return "interno";
  if (host.endsWith(".localhost")) return "interno";
  if (ROTULO_DE_IP.test(rotulos[rotulos.length - 1]!)) {
    const octetos = octetosCanonicos(host);
    if (!octetos) return "formato";
    if (ipInterno(octetos)) return "interno";
  }
  return null;
}

export function servidorSipValido(host: string): boolean {
  return motivoDoServidorInvalido(host) === null;
}

/**
 * O que a pessoa digita no campo "Servidor": aceita `sip:`/`sips:` e uma porta
 * colados, que é como muita operadora escreve no e-mail de boas-vindas.
 */
export function normalizarServidor(bruto: string): string {
  return bruto.trim().toLowerCase().replace(/^sips?:/, "").replace(/:\d+$/, "");
}

/**
 * Usuário da conta SIP. Vai para `username`, `from_user`, `client_uri` e
 * `contact_user`; `@`, `:`, `;`, `<`, `>` e aspas quebrariam a URI em que ele
 * é colado, e caractere de controle não é usuário de ninguém.
 */
export function usuarioSipValido(usuario: string): boolean {
  return usuario.length >= 1 && usuario.length <= 64 && !/[\s@:;<>"\x00-\x1f\x7f]/.test(usuario);
}

/** Porta que o Asterisk aceita num `server_uri`. */
export function portaSipValida(porta: number): boolean {
  return Number.isInteger(porta) && porta >= 1 && porta <= 65535;
}
