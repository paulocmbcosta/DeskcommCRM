/**
 * A volta que uma coluna `bytea` dá pelo PostgREST, para os bancos FALSOS dos
 * testes de unidade.
 *
 * Na escrita, a string JSON passa pela entrada de `bytea` do Postgres: com o
 * prefixo `\x`, o resto é lido como hex (os bytes que ele representa); sem o
 * prefixo, no formato "escape" — os bytes dos próprios caracteres. Na leitura, o
 * PostgREST devolve `bytea` como `"\x" + hex` dos bytes guardados (`to_json`,
 * `bytea_output = hex`).
 *
 * Um banco falso que guarda e devolve a MESMA string esconde exatamente o defeito
 * que existiu em `lib/api/idempotency.ts`: o hash era gravado sem o `\x`, voltava
 * como `\x3966…` e nunca casava — todo replay virava 409. O caminho real é medido
 * em tests/invariants/idempotencia-recibo-no-banco.test.ts; isto só impede que os
 * testes de unidade meçam o mock.
 */
export function byteaComoPostgrest(escrito: unknown): string {
  if (typeof escrito !== "string") throw new Error(`bytea do PostgREST: esperava texto, veio ${typeof escrito}`);
  if (escrito.startsWith("\\x")) {
    const hex = escrito.slice(2);
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error("invalid hexadecimal data (a entrada de bytea recusaria)");
    return `\\x${hex.toLowerCase()}`;
  }
  // Formato escape: sem barra invertida, cada caractere vira o próprio byte.
  if (escrito.includes("\\")) throw new Error("bytea do PostgREST: formato escape com barra não é reproduzido aqui");
  return `\\x${Buffer.from(escrito, "latin1").toString("hex")}`;
}
