/**
 * O WORKER NÃO EMPURRA TRONCO INVÁLIDO PARA O ASTERISK.
 *
 * A rota valida com Zod; a linha de `channel_sessions` não. Um admin grava
 * `sip_server`/`sip_username` direto pela REST, e o sincronizador lia a linha e
 * empurrava o valor cru pela ARI — uma vírgula no servidor virava um segundo
 * contato na AOR (o `contact` é lista), e o Asterisk passava a mandar OPTIONS
 * para onde ela apontasse. Aqui se mede o EFEITO: o que chega à ARI, o estado
 * que a tela vê e o log.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import type { ClienteAri } from "./ari";
import type { Registro } from "./controle";

const ami = vi.hoisted(() => ({ registros: [] as Array<{ objeto: string; estado: string }> }));
vi.mock("./ami", () => ({ lerRegistros: vi.fn(async () => ami.registros) }));

import { MOTIVO_CONFIGURACAO_INVALIDA, SincronizadorDeTroncos, TroncoInvalido, empurrarTronco } from "./sincronizacao";

const ORG = "00000000-0000-4000-8000-00000000000a";
const VALIDO = "11111111-1111-4111-8111-111111111111";
const INVALIDO = "22222222-2222-4222-8222-222222222222";

function linha(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: ORG,
    phone_number: "+556136861503",
    display_name: "Totus",
    sip_server: "voip.totussistema.com.br",
    sip_port: 5060,
    sip_transport: "udp",
    sip_username: `u-${id.slice(0, 4)}`,
    senha: "segredo",
    sip_team_id: null,
    ...over,
  };
}

function ariFalsa() {
  const chamadas: Array<{ op: "gravar" | "apagar"; tipo: string; id: string; campos?: unknown }> = [];
  const ari = {
    gravarObjeto: vi.fn(async (tipo: string, id: string, campos: unknown) => {
      chamadas.push({ op: "gravar", tipo, id, campos });
    }),
    apagarObjeto: vi.fn(async (tipo: string, id: string) => {
      chamadas.push({ op: "apagar", tipo, id });
    }),
  };
  return { ari: ari as unknown as ClienteAri, chamadas };
}

function bancoFalso(linhas: Array<Record<string, unknown>>) {
  const estados: Array<{ id: string; status: string; motivo: string | null }> = [];
  const atual = new Map<string, { status: string; motivo: string | null }>();
  const db: Queryable = {
    query: (async (sql: string, params: unknown[] = []) => {
      if (/^\s*select/i.test(sql) && /from channel_sessions/.test(sql)) return { rows: linhas, rowCount: linhas.length };
      if (/^\s*update channel_sessions/i.test(sql)) {
        const [id, , status, motivo] = params as [string, string, string, string | null];
        const antes = atual.get(id);
        if (antes && antes.status === status && antes.motivo === motivo) return { rows: [], rowCount: 0 };
        atual.set(id, { status, motivo });
        estados.push({ id, status, motivo });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`consulta inesperada: ${sql}`);
    }) as unknown as Queryable["query"],
  };
  return { db, estados };
}

function registroFalso() {
  const avisos: Array<{ msg: string; campos?: Record<string, unknown> }> = [];
  const log: Registro = {
    info: () => undefined,
    warn: (msg, campos) => avisos.push({ msg, campos }),
    error: () => undefined,
  };
  return { log, avisos };
}

beforeEach(() => {
  ami.registros = [];
});

describe("empurrarTronco", () => {
  it("tronco inválido lança ANTES de qualquer chamada à ARI — nem o apagar roda", async () => {
    const { ari, chamadas } = ariFalsa();
    const invalido = {
      id: INVALIDO,
      servidor: "voip.exemplo.com,sip:10.0.0.5",
      porta: 5060,
      transporte: "udp" as const,
      usuario: "u",
      senha: "s",
    };

    await expect(empurrarTronco(ari, invalido)).rejects.toBeInstanceOf(TroncoInvalido);
    expect(chamadas).toHaveLength(0);
  });
});

describe("SincronizadorDeTroncos", () => {
  it("empurra o válido, recusa o inválido, marca-o na tela e avisa no log uma vez só", async () => {
    const { ari, chamadas } = ariFalsa();
    const { db, estados } = bancoFalso([
      linha(VALIDO),
      linha(INVALIDO, { sip_server: "voip.exemplo.com,sip:redis:6379" }),
    ]);
    const { log, avisos } = registroFalso();
    const sync = new SincronizadorDeTroncos(ari, db, log, { host: "asterisk", senha: "x" });

    await sync.sincronizar(true);

    const gravados = new Set(chamadas.filter((c) => c.op === "gravar").map((c) => c.id));
    expect(gravados).toEqual(new Set([`tronco-${VALIDO}`]));
    // Nenhum valor do tronco inválido chegou à ARI, nem como campo de outro objeto.
    expect(JSON.stringify(chamadas)).not.toContain("redis");
    expect(estados).toContainEqual({ id: INVALIDO, status: "FAILED", motivo: MOTIVO_CONFIGURACAO_INVALIDA });
    const aviso = avisos.find((a) => a.msg.includes("configuração inválida"));
    expect(aviso?.campos).toEqual({ tronco: INVALIDO, problema: "servidor_invalido" });

    // A reconciliação roda a cada minuto: o aviso não se repete sem mudança.
    await sync.sincronizar();
    expect(avisos.filter((a) => a.msg.includes("configuração inválida"))).toHaveLength(1);
  });

  it("a versão válida que ficou no Asterisk é RETIRADA quando a linha passa a ser inválida", async () => {
    // O banco é a fonte da verdade: seguir registrando com a configuração
    // velha faria a ligação chegar enquanto a tela diz "Falhou".
    const { ari, chamadas } = ariFalsa();
    const { db } = bancoFalso([linha(INVALIDO, { sip_username: "a;x=y" })]);
    ami.registros = [{ objeto: `tronco-${INVALIDO}`, estado: "Registered" }];
    const sync = new SincronizadorDeTroncos(ari, db, registroFalso().log, { host: "asterisk", senha: "x" });

    await sync.sincronizar(true);

    expect(chamadas.filter((c) => c.op === "gravar")).toHaveLength(0);
    expect(chamadas.filter((c) => c.op === "apagar").map((c) => c.id)).toContain(`tronco-${INVALIDO}`);
  });
});
