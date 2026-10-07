import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PRAZO_DA_DEVOLUCAO_MS } from "@/lib/agent-engine/queue/parada";

/**
 * A PARADA DO WORKER TEM DE CABER ANTES DO SIGKILL DO DOCKER.
 *
 * São três números em três arquivos, e nenhum deles sabe dos outros:
 *
 *   - `stop_grace_period` do serviço `worker` (docker-compose.prod.yml): quanto o
 *     Docker espera entre o SIGTERM e o SIGKILL;
 *   - o default de `SHUTDOWN_GRACE_MS` (lib/agent-engine/env.ts): quanto o worker
 *     espera os jobs em curso;
 *   - `PRAZO_DA_DEVOLUCAO_MS` (lib/agent-engine/queue/parada.ts): quanto ele
 *     gasta, no pior caso, devolvendo à fila os que não terminaram.
 *
 * Enquanto o compose não declarava nada, valia o padrão do Docker — 10 s — contra
 * 30 s de `SHUTDOWN_GRACE_MS`: o SIGKILL chegava sempre antes, e a drenagem que
 * o código descrevia nunca chegava ao fim. Medido em produção em 2026-10-05: o
 * job ficou `running` com o `locked_by` de um processo morto e o cliente esperou
 * mais de 20 minutos pela resposta.
 *
 * O teste de comportamento da parada é `tests/unit/queue-parada.test.ts`; o do
 * `update` no banco, `tests/invariants/parada-devolve-jobs-do-worker.test.ts`.
 * Este aqui guarda só a CONTA e a LIGAÇÃO — o que nenhum dos dois enxerga.
 */
const RAIZ = process.cwd();
const ler = (rel: string) => fs.readFileSync(path.join(RAIZ, rel), "utf8");

/** O bloco de um serviço do compose: da linha `  nome:` até o próximo serviço. */
function servico(yaml: string, nome: string): string {
  const linhas = yaml.split("\n");
  const inicio = linhas.findIndex((l) => l === `  ${nome}:`);
  if (inicio < 0) throw new Error(`serviço '${nome}' não está em docker-compose.prod.yml`);
  const fim = linhas.findIndex((l, i) => i > inicio && /^ {2}[a-z][a-z0-9-]*:\s*$/.test(l));
  return linhas.slice(inicio, fim < 0 ? undefined : fim).join("\n");
}

/** Margem para o que não é espera: abortar os loops, abrir a conexão, sair. */
const FOLGA_MS = 5_000;

describe("a parada do worker cabe antes do SIGKILL do Docker", () => {
  const worker = servico(ler("docker-compose.prod.yml"), "worker");
  const declarado = worker.match(/^ {4}stop_grace_period:\s*(\d+)s\s*$/m)?.[1];
  const graceDoWorker = ler("lib/agent-engine/env.ts").match(
    /SHUTDOWN_GRACE_MS:\s*z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.default\(([\d_]+)\)/,
  )?.[1];

  it("as duas fontes ainda têm a forma que este teste lê", () => {
    // Sem isto, um `stop_grace_period: 1m` ou um default reescrito fariam o caso
    // abaixo comparar `NaN` e reprovar com uma mensagem que não diz o motivo.
    expect(declarado, "worker sem `stop_grace_period: <N>s` no compose de produção").toBeDefined();
    expect(graceDoWorker, "default de SHUTDOWN_GRACE_MS não encontrado em env.ts").toBeDefined();
  });

  it("stop_grace_period ≥ SHUTDOWN_GRACE_MS + a devolução + folga", () => {
    const dockerMs = Number(declarado) * 1000;
    const workerMs = Number(String(graceDoWorker).replace(/_/g, "")) + PRAZO_DA_DEVOLUCAO_MS + FOLGA_MS;
    expect(
      dockerMs,
      `o Docker mata o worker em ${dockerMs} ms, mas a parada pode levar ${workerMs} ms — ` +
        "o SIGKILL chegaria antes de os jobs em curso serem devolvidos à fila",
    ).toBeGreaterThanOrEqual(workerMs);
  });

  it("o main do worker usa a parada com prazo desde o sinal, e devolve por conexão própria", () => {
    // Guarda de LIGAÇÃO, não prova de execução: `main.ts` não tem seam de teste
    // sem subir o worker inteiro. O que ela pega é a regressão de volta ao
    // desenho antigo — esperar os loops sem prazo e sair sem devolver.
    const main = ler("workers/agent-worker/main.ts");
    const chamada = main.match(/drenarOuDevolver\(\{[\s\S]*?\n {4}\}\);/)?.[0] ?? "";
    expect(chamada, "main.ts não chama drenarOuDevolver").not.toBe("");
    expect(chamada).toContain("prazoMs: env.SHUTDOWN_GRACE_MS");
    expect(chamada).toMatch(/devolver:\s*\(\)\s*=>\s*devolverPorConexaoPropria\(env\.SUPABASE_DB_URL, workerId\)/);
    // O loop de claim entra na MESMA espera com prazo que os outros: é o único
    // jeito de a foto dos jobs em voo ser final.
    expect(chamada).toContain("workerLoop");
    // E fora dela, nenhum loop é esperado sem prazo. Só CÓDIGO conta: a linha
    // tem de começar pelo `await` (comentário que cite o nome não é espera).
    const fora = main.replace(chamada, "");
    expect(fora).not.toMatch(/^\s*await workerLoop\b/m);
    expect(fora).not.toMatch(/^\s*await Promise\.all\(\[\s*drainLoop/m);
  });
});
