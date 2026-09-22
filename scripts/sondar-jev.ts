/**
 * SONDA DO JEV — manda conversas rotuladas ao Jev pela OpenRouter e imprime o
 * que ele decidiu, com a latência. Mede ANTES de construir o resto: a doc do
 * Jev diz que o português "não funciona igualmente bem" e manda testar.
 *
 * Uso:
 *   npx tsx --env-file=.env.sonda scripts/sondar-jev.ts [arquivo.json] [limiar]
 *   (padrão: tests/fixtures/jev/conversas-de-exemplo.json, limiar 0.7)
 *
 * Grava a PRIMEIRA resposta crua em tests/fixtures/jev/resposta-real.json: o
 * teste do cliente a lê, e é isso que amarra o schema ao contrato REAL.
 * A chave nunca é impressa. Para calibrar com conversas reais de um cliente,
 * use um arquivo FORA do repositório (tem dado pessoal).
 */
import * as fs from "node:fs";

import { custoEmCentavos, perguntarAoJev } from "@/lib/classificador-comercial/jev";
import { decidir, MODELO_DO_JEV, type EstadoDoJev } from "@/lib/classificador-comercial/perguntas";

interface Caso {
  esperado: "sim" | "nao";
  assunto: string;
  conversa: EstadoDoJev["conversa"];
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    process.stderr.write("OPENROUTER_API_KEY ausente — coloque no .env.sonda e rode com --env-file=.env.sonda\n");
    process.exit(2);
  }
  const arquivo = process.argv[2] ?? "tests/fixtures/jev/conversas-de-exemplo.json";
  const limiar = Number(process.argv[3] ?? 0.7);
  const casos = JSON.parse(fs.readFileSync(arquivo, "utf8")) as Caso[];

  let cru: unknown = null;
  const fetchQueGuarda: typeof fetch = async (url, init) => {
    const r = await fetch(url, init);
    if (cru === null && r.ok) cru = JSON.parse(await r.clone().text());
    return r;
  };

  let acertos = 0;
  const latencias: number[] = [];
  let tokensDeEntradaTotal = 0;
  let tokensDeEntradaConhecidos = true;
  let modeloQueRespondeu: string | null = null;
  for (const [i, caso] of casos.entries()) {
    const r = await perguntarAoJev({ apiKey, estado: { conversa: caso.conversa }, modelo: MODELO_DO_JEV, fetchImpl: fetchQueGuarda });
    latencias.push(r.latenciaMs);
    if (!r.ok) {
      process.stdout.write(`#${i + 1} FALHA ${r.falha.tipo} ${r.falha.status ?? "-"} ${r.falha.detalhe}\n`);
      continue;
    }
    if (modeloQueRespondeu === null) modeloQueRespondeu = r.resposta.modelo;
    if (r.resposta.tokensDeEntrada === null) tokensDeEntradaConhecidos = false;
    else tokensDeEntradaTotal += r.resposta.tokensDeEntrada;
    const d = decidir(r.resposta, limiar);
    const obtido = d.criar ? "sim" : "nao";
    if (obtido === caso.esperado) acertos++;
    process.stdout.write(
      `#${i + 1} esperado=${caso.esperado}/${caso.assunto} obtido=${obtido}/${d.assunto} ` +
        `assunto_cru=${r.resposta.assunto ?? "-"} p=${r.resposta.comercial.toFixed(2)} ${r.latenciaMs}ms ` +
        `${obtido === caso.esperado ? "OK" : "ERRO"}\n`,
    );
  }

  if (cru !== null) {
    fs.mkdirSync("tests/fixtures/jev", { recursive: true });
    fs.writeFileSync("tests/fixtures/jev/resposta-real.json", `${JSON.stringify(cru, null, 2)}\n`);
  }
  const ordenadas = [...latencias].sort((a, b) => a - b);
  const mediana = ordenadas[Math.floor(ordenadas.length / 2)] ?? 0;
  const custoTotal = tokensDeEntradaConhecidos ? custoEmCentavos(tokensDeEntradaTotal) : null;
  process.stdout.write(
    `\nacertos: ${acertos}/${casos.length} (limiar ${limiar}) · latência mediana ${mediana}ms · máx ${ordenadas.at(-1) ?? 0}ms\n` +
      `tokens de entrada (soma): ${tokensDeEntradaConhecidos ? tokensDeEntradaTotal : "desconhecido (algum caso não informou usage)"} · ` +
      `custo total estimado: ${custoTotal === null ? "desconhecido" : `${custoTotal.toFixed(4)} centavos`} · ` +
      `model: ${modeloQueRespondeu ?? "-"}\n`,
  );
}

void main();
