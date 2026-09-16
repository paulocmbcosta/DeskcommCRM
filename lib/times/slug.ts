/**
 * Slug do time: token estável que o agente usa para escolher o destino.
 *
 * Ele é SUGERIDO a partir do nome e depois editável — não é derivação viva. Como
 * o agente lê o catálogo em runtime, trocar o slug não quebra prompt nenhum.
 */
export function slugDoTime(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}
