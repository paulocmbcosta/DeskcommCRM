/**
 * O VOLUME DAS FALAS CHEGA A QUEM JÁ INSTALOU — e no caminho que o código usa.
 *
 * O worker escreve as falas do telefone num volume nomeado e o Asterisk o lê só
 * leitura (desenho da fase 2, D12). Quatro coisas que nenhum outro gate mede:
 *  1. o volume está DECLARADO no topo — o `dc up -d` do update.sh cria volume
 *     declarado, e é assim que ele chega a quem já instalou, sem editar arquivo;
 *  2. o worker monta com escrita e o asterisk SÓ leitura (`:ro`);
 *  3. os dois no caminho que `falas-no-disco.ts` escreve e manda o Asterisk tocar
 *     — um caminho trocado de um lado só daria silêncio em toda URA;
 *  4. nenhum outro serviço monta o volume — em nenhuma das sintaxes do compose,
 *     nem pelo override do Traefik: quem escreve é só o worker.
 *
 * Não é um parser de YAML (o molde é tests/unit/portas-do-compose.test.ts): é o
 * suficiente para responder "este serviço monta X?" sem dependência nova.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DIRETORIO_DAS_FALAS, DIRETORIO_NO_ASTERISK } from "@/lib/channels/telefonia/falas-no-disco";

const VOLUME = "telefonia-falas";
const ler = (arquivo: string) => readFileSync(join(process.cwd(), arquivo), "utf8");
const linhas = ler("docker-compose.prod.yml").split("\n");

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Os serviços de um compose: da linha `  nome:` (dentro de `services:`) até o
 * próximo cabeçalho do mesmo nível ou do topo. Linhas de comentário saem.
 */
function servicos(texto: string): Map<string, string> {
  const mapa = new Map<string, string>();
  const todas = texto.split("\n");
  const inicio = todas.findIndex((l) => /^services:\s*$/.test(l));
  if (inicio === -1) throw new Error("bloco services: não encontrado no compose");
  let atual: string | null = null;
  let buffer: string[] = [];
  const fechar = () => {
    if (atual) mapa.set(atual, buffer.filter((l) => !/^\s*#/.test(l)).join("\n"));
    atual = null;
    buffer = [];
  };
  for (const l of todas.slice(inicio + 1)) {
    if (/^\S/.test(l)) break;
    const cabecalho = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(l);
    if (cabecalho) {
      fechar();
      atual = cabecalho[1]!;
      continue;
    }
    if (atual) buffer.push(l);
  }
  fechar();
  return mapa;
}

function volumesDoTopo(): string[] {
  const inicio = linhas.findIndex((l) => l === "volumes:");
  if (inicio === -1) throw new Error("bloco volumes: do topo não encontrado");
  const nomes: string[] = [];
  for (const l of linhas.slice(inicio + 1)) {
    if (/^\S/.test(l)) break;
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(l);
    if (m) nomes.push(m[1]!);
  }
  return nomes;
}

/** As linhas de montagem do volume das falas num serviço, na sintaxe curta (sem comentários). */
function montagens(bloco: string): string[] {
  return [...bloco.matchAll(new RegExp(`^\\s+-\\s*"?(${VOLUME}:[^"\\s]+)"?\\s*$`, "gm"))].map((m) => m[1]!);
}

/**
 * O serviço cita o volume em QUALQUER sintaxe de montagem — a curta
 * (`- telefonia-falas:/x`), a longa (`source: telefonia-falas`) e a em linha
 * (`- { source: telefonia-falas, ... }`): o nome como palavra inteira. Um
 * `telefonia-falas-antigo` não conta.
 */
function montaOVolume(bloco: string): boolean {
  return new RegExp(`(^|[^a-z0-9_-])${escapar(VOLUME)}($|[^a-z0-9_-])`, "m").test(bloco);
}

const SERVICOS = servicos(ler("docker-compose.prod.yml"));
const DO_TRAEFIK = servicos(ler("docker-compose.traefik.yml"));

describe("o volume das falas do telefone no compose de produção", () => {
  it("o parser enxerga os serviços (guarda do instrumento)", () => {
    // Sem esta asserção, um parser quebrado deixaria os casos abaixo verdes por
    // não terem medido nada.
    expect([...SERVICOS.keys()]).toEqual(expect.arrayContaining(["worker", "asterisk", "app"]));
    expect(SERVICOS.get("worker")).toMatch(/^\s+image:/m);
    expect(SERVICOS.get("asterisk")).toMatch(/^\s+image:/m);
  });

  it("está declarado no topo (o update.sh só cria volume declarado)", () => {
    expect(volumesDoTopo()).toContain(VOLUME);
  });

  it("o worker monta com escrita, no caminho em que o código escreve", () => {
    expect(montagens(SERVICOS.get("worker")!)).toEqual([`${VOLUME}:${DIRETORIO_DAS_FALAS}`]);
  });

  it("o asterisk monta SÓ LEITURA, no caminho que o código manda tocar", () => {
    expect(montagens(SERVICOS.get("asterisk")!)).toEqual([`${VOLUME}:${DIRETORIO_NO_ASTERISK}:ro`]);
  });

  it("o caminho absoluto que a ARI toca é o mesmo em que o worker escreve (passo zero, ramo A)", () => {
    // `midiaDaFala` manda o Asterisk tocar `DIRETORIO_NO_ASTERISK/...`, e o worker
    // grava em `DIRETORIO_DAS_FALAS/...`: com o mesmo volume montado nos dois
    // pontos, os dois caminhos têm de ser um só.
    expect(DIRETORIO_NO_ASTERISK).toBe(DIRETORIO_DAS_FALAS);
    expect(DIRETORIO_DAS_FALAS).toMatch(/^\//);
  });

  it("o detector enxerga as três sintaxes de montagem (guarda do instrumento)", () => {
    expect(montaOVolume(`    volumes:\n      - ${VOLUME}:/x:ro`)).toBe(true);
    expect(montaOVolume(`    volumes:\n      - type: volume\n        source: ${VOLUME}\n        target: /x`)).toBe(true);
    expect(montaOVolume(`    volumes:\n      - { type: volume, source: "${VOLUME}", target: /x }`)).toBe(true);
    expect(montaOVolume(`    volumes:\n      - ${VOLUME}-antigo:/x`)).toBe(false);
    expect(montaOVolume("    volumes:\n      - waha-data:/app/.sessions")).toBe(false);
    // E enxerga os dois que montam de verdade.
    expect(montaOVolume(SERVICOS.get("worker")!)).toBe(true);
    expect(montaOVolume(SERVICOS.get("asterisk")!)).toBe(true);
  });

  it("nenhum outro serviço monta o volume — nem pelo override do Traefik", () => {
    expect([...DO_TRAEFIK.keys()], "o parser não enxergou o override do Traefik").toContain("app");
    const outros = [
      ...[...SERVICOS].map(([nome, bloco]) => ["docker-compose.prod.yml", nome, bloco] as const),
      ...[...DO_TRAEFIK].map(([nome, bloco]) => ["docker-compose.traefik.yml", nome, bloco] as const),
    ]
      .filter(([, nome]) => nome !== "worker" && nome !== "asterisk")
      .filter(([, , bloco]) => montaOVolume(bloco))
      .map(([arquivo, nome]) => `${arquivo} → ${nome}`);
    expect(outros).toEqual([]);
  });
});
