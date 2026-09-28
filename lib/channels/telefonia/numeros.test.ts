/**
 * O CADASTRO DO NÚMERO: a régua do servidor e a senha que não muda de conta.
 *
 * Dois defeitos da revisão de segurança de 2026-09-28, medidos aqui pelo
 * comportamento — o que a função devolve e o que chega ao banco —, não pela
 * presença de um símbolo:
 *
 *  1. O `numeroSchema` aceitava servidor interno (`localhost`, `redis`,
 *     `10.x`, `169.254.169.254`). Agora usa a régua de `conta-sip.ts`, a mesma
 *     do worker.
 *  2. O PATCH trocava o servidor (ou usuário, porta, transporte) mantendo a
 *     senha guardada: quem edita nunca viu a senha, e editar virava o jeito de
 *     mandá-la para outro host. Sem `senha` no corpo, a conta tem de ser a
 *     mesma — e a recusa acontece SEM escrita nenhuma.
 */
import { describe, expect, it } from "vitest";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { MENSAGEM_DA_FALHA, atualizarNumero, numeroSchema, type EntradaDoNumero } from "./numeros";

const ORG = "00000000-0000-4000-8000-00000000000a";
const NUMERO = "11111111-1111-4111-8111-111111111111";

const base = {
  nome: "Totus 3025",
  numero: "(61) 3686-1503",
  servidor: "voip.totussistema.com.br",
  porta: 5060,
  transporte: "udp",
  usuario: "6136861503",
  time_id: null,
};

describe("numeroSchema — o servidor da tela", () => {
  it.each(["voip.totussistema.com.br", "sip:VOIP.totussistema.com.br:5060", "45.5.156.58"])(
    "aceita %s",
    (servidor) => {
      expect(numeroSchema.safeParse({ ...base, servidor }).success).toBe(true);
    },
  );

  it.each(["localhost", "127.0.0.1", "asterisk", "redis", "10.0.0.5", "172.18.0.3", "192.168.0.10", "169.254.169.254", "0.0.0.0"])(
    "recusa %s, com a explicação no campo",
    (servidor) => {
      const r = numeroSchema.safeParse({ ...base, servidor });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.flatten().fieldErrors.servidor?.[0]).toMatch(/endereço público da operadora/);
      }
    },
  );
});

interface Consulta {
  sql: string;
  params: unknown[];
}

/** A conta guardada no banco, como `atualizarNumero` a lê. */
const GUARDADA = { servidor: "voip.totussistema.com.br", porta: 5060, transporte: "udp", usuario: "6136861503" };

function bancoFalso(guardada: typeof GUARDADA | null = GUARDADA) {
  const consultas: Consulta[] = [];
  const db: Queryable = {
    query: (async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (/from attendance_teams/.test(sql)) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      if (/^\s*select/i.test(sql) && /from channel_sessions/.test(sql)) {
        return { rows: guardada ? [guardada] : [], rowCount: guardada ? 1 : 0 };
      }
      if (/^\s*update channel_sessions/i.test(sql)) return { rows: [], rowCount: 1 };
      throw new Error(`consulta inesperada: ${sql}`);
    }) as unknown as Queryable["query"],
  };
  const updates = () => consultas.filter((c) => /^\s*update channel_sessions/i.test(c.sql));
  return { db, consultas, updates };
}

const entrada = (over: Partial<EntradaDoNumero> = {}): EntradaDoNumero =>
  numeroSchema.parse({ ...base, ...over });

describe("atualizarNumero — a senha é da conta", () => {
  it.each([
    ["servidor", { servidor: "sip.outro-lugar.example.com" }],
    ["usuário", { usuario: "outro-usuario" }],
    ["porta", { porta: 5080 }],
    ["transporte", { transporte: "tcp" as const }],
  ])("trocar o %s sem senha é recusado, e nada é gravado", async (_campo, mudanca) => {
    const { db, updates } = bancoFalso();

    const r = await atualizarNumero(db, ORG, NUMERO, entrada(mudanca));

    expect(r).toEqual({ ok: false, motivo: "senha_obrigatoria_na_troca" });
    expect(updates()).toHaveLength(0);
    expect(MENSAGEM_DA_FALHA.senha_obrigatoria_na_troca).toMatch(/digite a senha da conta SIP de novo/);
  });

  it("trocar o servidor COM a senha nova grava, e a senha vai junto", async () => {
    const { db, updates } = bancoFalso();

    const r = await atualizarNumero(db, ORG, NUMERO, entrada({ servidor: "sip.outro-lugar.example.com", senha: "nova" }));

    expect(r).toEqual({ ok: true });
    expect(updates()).toHaveLength(1);
    expect(updates()[0]!.params).toContain("nova");
  });

  it("mudar só o nome e o time, sem senha, mantém a guardada e grava", async () => {
    const { db, updates } = bancoFalso();

    const r = await atualizarNumero(db, ORG, NUMERO, entrada({ nome: "Novo nome" }));

    expect(r).toEqual({ ok: true });
    expect(updates()).toHaveLength(1);
    // A senha vai como NULL: o `case when` do UPDATE mantém a cifrada.
    expect(updates()[0]!.params.at(-1)).toBeNull();
  });

  it("servidor guardado com outra caixa (gravado pela REST) não conta como troca", async () => {
    const { db, updates } = bancoFalso({ ...GUARDADA, servidor: "voip.totussistema.com.br" });

    const r = await atualizarNumero(db, ORG, NUMERO, entrada({ servidor: "VOIP.TotusSistema.com.br" }));

    expect(r).toEqual({ ok: true });
    expect(updates()).toHaveLength(1);
  });

  it("o UPDATE repete a regra dentro do comando — edição simultânea não troca a conta sem senha", async () => {
    const { db, updates } = bancoFalso();

    await atualizarNumero(db, ORG, NUMERO, entrada({ nome: "Novo nome" }));

    expect(updates()[0]!.sql).toMatch(
      /\$11::text is not null\s+or \(lower\(sip_server\) = \$6 and coalesce\(sip_port, 5060\) = \$7\s+and coalesce\(sip_transport, 'udp'\) = \$8 and sip_username = \$9\)/,
    );
  });

  it("número de outra organização (ou arquivado) é 'não encontrado', sem escrita", async () => {
    const { db, updates } = bancoFalso(null);

    const r = await atualizarNumero(db, ORG, NUMERO, entrada({ servidor: "sip.outro-lugar.example.com" }));

    expect(r).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(updates()).toHaveLength(0);
  });
});
