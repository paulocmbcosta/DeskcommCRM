/**
 * SONDA DO JEV — manda conversas rotuladas ao Jev pela OpenRouter e imprime o
 * que ele decidiu, com a latência. Mede ANTES de construir o resto: a doc do
 * Jev diz que o português "não funciona igualmente bem" e manda testar.
 *
 * Uso:
 *   npx tsx --env-file=.env.sonda scripts/sondar-jev.ts [arquivo.json] [limiar] [--gravar-contrato]
 *   (padrão: tests/fixtures/jev/conversas-de-exemplo.json, limiar 0.7)
 *
 * Cada caso do arquivo é `{ esperado: "sim"|"nao", assunto: string, mensagens: MensagemParaEstado[] }`
 * — o MESMO formato que a produção monta (`lib/classificador-comercial/perguntas.ts:montarEstado`),
 * então a sonda exercita o corte de 12 falas / 500 code points e o descarte de conversa só do
 * atendente, não uma forma abreviada. Um caso cujas mensagens são só do atendente conta à parte
 * ("sem fala do cliente"), não como falha nem como acerto/erro.
 *
 * `--gravar-contrato`: só com essa flag a sonda GRAVA a primeira resposta ok em
 * tests/fixtures/jev/resposta-real.json — e só os campos CONHECIDOS
 * (model, answers.comercial.{type,noul}, answers.assunto.{type,choice,confidence}, e dentro de
 * `probabilities`, só chaves conhecidas de `ASSUNTOS` com valor numérico;
 * usage.{input_tokens,output_tokens,cost} — ver `extrairContratoConhecido` em
 * `scripts/lib/sonda-jev.ts`), nunca o corpo inteiro: sem `id` de geração, sem campo/chave novo do
 * provedor que possa repetir texto da conversa. Sem a flag, a sonda só IMPRIME — a fixture
 * versionada não é sobrescrita à toa (um revisor pode estar rodando o teste do contrato no
 * mesmo worktree). E a flag SÓ funciona com o arquivo sintético padrão
 * (`tests/fixtures/jev/conversas-de-exemplo.json`, comparado pelo caminho RESOLVIDO —
 * `ehArquivoSinteticoPadrao`); passar `--gravar-contrato` com outro arquivo (ex.: conversas reais
 * de um cliente) é recusado antes de qualquer chamada.
 *
 * A chave nunca é impressa. Em FALHA, a linha mostra só `tipo` e `status` — nunca `detalhe`,
 * que pode ecoar parte do `state` (a conversa) num erro de contrato 4xx.
 *
 * Fora do `pnpm typecheck` (`tsconfig.typecheck.json` exclui `scripts/**`): depois de mexer na
 * assinatura de `lib/classificador-comercial/jev.ts`, rode `pnpm exec tsc --noEmit -p tsconfig.json`
 * para conferir este arquivo também.
 *
 * Para calibrar com conversas reais de um cliente, use um arquivo FORA do repositório (tem dado
 * pessoal) — a sonda recusa `--gravar-contrato` nesse caso; a fixture versionada é só para o
 * conjunto sintético.
 */
import * as fs from "node:fs";

import { perguntarAoJev } from "@/lib/classificador-comercial/jev";
import { decidir, montarEstado, MODELO_DO_JEV } from "@/lib/classificador-comercial/perguntas";

import {
  analisarLimiar,
  ARQUIVO_SINTETICO_PADRAO,
  calcularMetricas,
  ehArquivoSinteticoPadrao,
  extrairContratoConhecido,
  nomeDoErro,
  validarCasos,
  type ResultadoDoCaso,
} from "./lib/sonda-jev";

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    process.stderr.write("OPENROUTER_API_KEY ausente — coloque no .env.sonda e rode com --env-file=.env.sonda\n");
    process.exit(2);
  }

  const gravarContrato = process.argv.includes("--gravar-contrato");
  const posicionais = process.argv.slice(2).filter((a) => a !== "--gravar-contrato");
  const arquivo = posicionais[0] ?? ARQUIVO_SINTETICO_PADRAO;

  // Só a fixture SINTÉTICA do repo pode ser regravada. Um arquivo de
  // conversas REAIS (fora do repo, com dado de cliente) nunca pode virar
  // tests/fixtures/jev/resposta-real.json — recusa ANTES de gastar chamadas.
  if (gravarContrato && !ehArquivoSinteticoPadrao(arquivo)) {
    process.stderr.write(
      `--gravar-contrato só grava a fixture sintética padrão (${ARQUIVO_SINTETICO_PADRAO}) — recebido "${arquivo}". ` +
        "Um arquivo de conversas reais nunca deve virar fixture versionada.\n",
    );
    process.exit(2);
  }

  const limiarLido = analisarLimiar(posicionais[1] ?? "0.7");
  if (!limiarLido.ok) {
    process.stderr.write(`${limiarLido.erro}\n`);
    process.exit(2);
  }
  const limiar = limiarLido.valor;

  // Ler + parsear num try/catch SÓ: o SyntaxError do JSON.parse cita um
  // TRECHO do texto que falhou — que pode ser a linha inteira de um arquivo
  // com dado de cliente. `nomeDoErro` corta isso fora.
  let bruto: unknown;
  try {
    bruto = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  } catch (err) {
    process.stderr.write(`sonda falhou ao ler/parsear ${arquivo}: ${nomeDoErro(err)}\n`);
    process.exit(2);
  }
  const casosLidos = validarCasos(bruto);
  if (!casosLidos.ok) {
    process.stderr.write(`sonda falhou: ${casosLidos.erro}\n`);
    process.exit(2);
  }
  const casos = casosLidos.casos;

  let cru: unknown = null;
  const fetchQueGuarda: typeof fetch = async (url, init) => {
    const r = await fetch(url, init);
    if (cru === null && r.ok) {
      try {
        cru = JSON.parse(await r.clone().text());
      } catch {
        // Corpo 200 que não é JSON: perguntarAoJev lê o texto de novo (não
        // reusa este clone) e classifica normalmente como "contrato" — aqui
        // só não temos o que guardar para a fixture.
      }
    }
    return r;
  };

  const resultados: ResultadoDoCaso[] = [];
  for (const [i, caso] of casos.entries()) {
    const estado = montarEstado(caso.mensagens);
    if (estado === null) {
      resultados.push({ tipo: "sem_fala_do_cliente" });
      process.stdout.write(`#${i + 1} SEM FALA DO CLIENTE — montarEstado descartou (só atendente, ou tudo vazio)\n`);
      continue;
    }
    const r = await perguntarAoJev({ apiKey, estado, modelo: MODELO_DO_JEV, fetchImpl: fetchQueGuarda });
    if (!r.ok) {
      resultados.push({ tipo: "falha" });
      process.stdout.write(`#${i + 1} FALHA ${r.falha.tipo} ${r.falha.status ?? "-"}\n`);
      continue;
    }
    const d = decidir(r.resposta, limiar);
    const obtido = d.criar ? "sim" : "nao";
    resultados.push({
      tipo: "respondida",
      esperado: caso.esperado,
      obtido,
      latenciaMs: r.latenciaMs,
      tokensDeEntrada: r.resposta.tokensDeEntrada,
      custoEmCentavos: r.resposta.custoEmCentavos,
      modelo: r.resposta.modelo,
    });
    process.stdout.write(
      `#${i + 1} esperado=${caso.esperado}/${caso.assunto} obtido=${obtido}/${d.assunto} ` +
        `assunto_cru=${r.resposta.assunto ?? "-"} p=${r.resposta.comercial.toFixed(2)} ${r.latenciaMs}ms ` +
        `${obtido === caso.esperado ? "OK" : "ERRO"}\n`,
    );
  }

  if (gravarContrato && cru !== null) {
    const contrato = extrairContratoConhecido(cru);
    if (contrato === null) {
      process.stderr.write("--gravar-contrato pedido, mas a resposta não tinha nem answers.comercial — nada gravado\n");
    } else {
      fs.mkdirSync("tests/fixtures/jev", { recursive: true });
      fs.writeFileSync("tests/fixtures/jev/resposta-real.json", `${JSON.stringify(contrato, null, 2)}\n`);
      process.stdout.write("\ncontrato gravado em tests/fixtures/jev/resposta-real.json (só campos conhecidos)\n");
    }
  }

  const m = calcularMetricas(resultados);
  process.stdout.write(
    `\nrespondidas: ${m.respondidas}/${m.total} · falhas: ${m.falhas} · sem fala do cliente: ${m.semFalaDoCliente} · ` +
      `acertos: ${m.acertos}/${m.respondidas} (limiar ${limiar})\n` +
      `latência mediana ${m.medianaMs}ms · máx ${m.maxMs}ms (só das respondidas)\n` +
      `matriz de confusão (esperado\\obtido): sim/sim=${m.matriz.simSim} sim/nao=${m.matriz.simNao} ` +
      `nao/sim=${m.matriz.naoSim} nao/nao=${m.matriz.naoNao}\n` +
      `tokens de entrada (soma): ${m.tokensDeEntradaTotal ?? "desconhecido"} · ` +
      `custo total: ${m.custoTotalEmCentavos === null ? "desconhecido" : `${m.custoTotalEmCentavos.toFixed(4)} centavos`} · ` +
      `model: ${m.modeloQueRespondeu ?? "-"}\n`,
  );

  if (m.todasFalharam) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`sonda falhou: ${nomeDoErro(err)}\n`);
  process.exit(1);
});
