/**
 * Senha aleatória para o botão "Gerar senha" do cadastro de membro.
 *
 * Quem administra vai PASSAR esta senha para a pessoa — ditando, mandando por
 * mensagem, anotando num papel. Por isso o alfabeto não tem 0/O nem 1/l/I, e a
 * senha sai em três blocos de quatro separados por hífen: 12 caracteres de 57
 * possíveis (~70 bits), longe do alcance de adivinhação e fácil de ler em voz
 * alta. Vem de `crypto.getRandomValues`, nunca de `Math.random`.
 */
export const ALFABETO_DA_SENHA = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function gerarSenha(): string {
  const blocos: string[] = [];
  // Rejeição acima do maior múltiplo do alfabeto: sem ela os primeiros
  // caracteres sairiam mais que os outros (viés de módulo).
  const limite = 256 - (256 % ALFABETO_DA_SENHA.length);
  let bloco = "";
  while (blocos.length < 3) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (const byte of bytes) {
      if (byte >= limite) continue;
      bloco += ALFABETO_DA_SENHA[byte % ALFABETO_DA_SENHA.length];
      if (bloco.length === 4) {
        blocos.push(bloco);
        bloco = "";
        if (blocos.length === 3) break;
      }
    }
  }
  return blocos.join("-");
}
