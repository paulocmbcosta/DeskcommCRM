import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * FUNÇÃO REDEFINIDA NO BASELINE NÃO PODE VOLTAR AO ESTADO ANTIGO A CADA UPDATE.
 *
 * O `update.sh` reaplica o `supabase/baseline.sql` INTEIRO, comando a comando,
 * fora de uma transação única. Uma função definida em dois blocos do apêndice é
 * recriada duas vezes por atualização: primeiro com a definição do bloco antigo,
 * depois com a do bloco novo. Entre uma e outra — o intervalo dura o que os
 * comandos do meio esperarem por trava, com o banco em uso — o que está de pé é
 * a definição ANTIGA.
 *
 * Para a maioria das funções isso é inofensivo. Para as desta lista, não: a
 * definição antiga tem outro MODO DE SEGURANÇA, outros grants ou deixa dado
 * para trás. O caso que abriu a lista (revisão dos consertos da 0298):
 * `fn_gravacao_da_mensagem_apagada` voltava a ser invoker, com EXECUTE para
 * `authenticated` e sem apagar a transcrição — a mensagem de ligação apagada
 * nesse intervalo deixava a transcrição órfã, com o texto da ligação.
 *
 * A regra: TODAS as definições da função no baseline são idênticas (em código,
 * sem os comentários) e os grants de todos os blocos são os mesmos. Ao
 * redefinir uma função destas numa migration nova, o bloco antigo do baseline
 * recebe a definição nova também.
 *
 * A lista só cresce. Entra aqui a função cuja definição antiga, de pé por um
 * instante, faz diferença — segurança ou dado.
 */
const SEM_JANELA = ["fn_gravacao_da_mensagem_apagada"] as const;

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

const semComentarios = (sql: string) =>
  sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/** Toda definição da função no arquivo: do `create or replace` ao fecho do corpo. */
function definicoes(nome: string): string[] {
  const achadas: string[] = [];
  const re = new RegExp(`create or replace function public\\.${nome}\\s*\\(`, "gi");
  for (let m = re.exec(BASELINE); m !== null; m = re.exec(BASELINE)) {
    const abertura = /\$([a-z_]*)\$/i.exec(BASELINE.slice(m.index, m.index + 600));
    if (!abertura) continue;
    const marca = abertura[0];
    const fim = BASELINE.indexOf(marca, m.index + abertura.index + marca.length);
    if (fim === -1) continue;
    achadas.push(semComentarios(BASELINE.slice(m.index, fim + marca.length)));
  }
  return achadas;
}

/** Os grants/revokes de EXECUTE da função, por ocorrência, na ordem do arquivo. */
function privilegios(nome: string): string[] {
  const re = new RegExp(`^(?:grant|revoke) execute on function public\\.${nome}\\s*\\([^)]*\\)[^;]*;`, "gim");
  return (BASELINE.match(re) ?? []).map((l) => l.replace(/\s+/g, " ").trim().toLowerCase());
}

describe("função redefinida no baseline não volta ao estado antigo a cada update", () => {
  it.each(SEM_JANELA)("%s: todas as definições do baseline são idênticas", (nome) => {
    const todas = definicoes(nome);
    // Sem este controle, uma sonda que não achasse nada passaria por vacuidade.
    expect(todas.length, `nenhuma definição de ${nome} encontrada no baseline`).toBeGreaterThan(0);
    for (const [i, d] of todas.entries()) {
      expect(d, `a ${i + 1}ª definição de ${nome} no baseline difere da última`).toBe(todas[todas.length - 1]);
    }
  });

  it.each(SEM_JANELA)("%s: os grants de EXECUTE são os mesmos em todos os blocos", (nome) => {
    const linhas = privilegios(nome);
    expect(linhas.length).toBeGreaterThan(0);
    const revokes = linhas.filter((l) => l.startsWith("revoke"));
    const grants = linhas.filter((l) => l.startsWith("grant"));
    expect(new Set(revokes).size, `revokes diferentes entre os blocos: ${revokes.join(" | ")}`).toBe(1);
    expect(new Set(grants).size, `grants diferentes entre os blocos: ${grants.join(" | ")}`).toBe(1);
  });

  it("fn_gravacao_da_mensagem_apagada: em nenhum bloco é invoker, nem executável por membro", () => {
    for (const d of definicoes("fn_gravacao_da_mensagem_apagada")) {
      expect(d).toMatch(/security definer/i);
      expect(d).toMatch(/set search_path = public/i);
      // É ela quem leva a transcrição junto com a mensagem da ligação.
      expect(d).toContain("delete from public.voice_call_transcripts");
    }
    for (const l of privilegios("fn_gravacao_da_mensagem_apagada")) {
      // Só o que vem depois de `to` / `from` são papéis (o nome da função também tem `public.`).
      if (l.startsWith("grant")) expect(l.split(" to ")[1]).toBe("service_role;");
      if (l.startsWith("revoke")) expect(l.split(" from ")[1]).toBe("public, anon, authenticated;");
    }
  });
});
