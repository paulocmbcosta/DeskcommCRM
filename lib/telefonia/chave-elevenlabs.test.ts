// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

// A cifra real depende de AI_CRED_AES_KEY; aqui importa só QUE o texto puro não chega ao banco.
vi.mock("@/lib/crypto/aes_gcm", () => ({
  encryptKey: (p: string) => ({
    ciphertext: Buffer.from(`cifrado:${p}`),
    iv: Buffer.alloc(12, 1),
    tag: Buffer.alloc(16, 2),
    last4: p.slice(-4),
  }),
  decryptKey: ({ ciphertext }: { ciphertext: Buffer }) => ciphertext.toString().replace(/^cifrado:/, ""),
  byteaToBuffer: (v: unknown) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v))),
}));

const logs = vi.hoisted(() => ({ warn: [] as Array<{ msg: string; ctx: unknown }> }));
vi.mock("@/lib/logger", () => ({
  logger: {
    warn: (msg: string, ctx: unknown) => logs.warn.push({ msg, ctx }),
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { PROVEDOR_DE_VOZ, ROTULO_DA_CHAVE_DE_VOZ, chaveDeVoz, estadoDaChaveDeVoz, guardarChaveDeVoz } from "./chave-elevenlabs";

function bancoFalso(linhas: Record<string, unknown>[] = []) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const db: Queryable = {
    query: (async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      return { rows: linhas, rowCount: linhas.length };
    }) as unknown as Queryable["query"],
  };
  return { db, consultas };
}

describe("a chave da ElevenLabs da organização", () => {
  it("guarda CIFRADA, com provider e rótulo fixos (uma por organização), e nunca o texto puro", async () => {
    const { db, consultas } = bancoFalso([{ id: "cred-1", substituiu: false }]);
    const r = await guardarChaveDeVoz(db, { organizationId: "org-1", userId: "user-1", chave: "sk_abcdefgh1234" });

    expect(r).toEqual({ id: "cred-1", last4: "1234", substituiu: false });
    expect(consultas[0]!.params.slice(0, 3)).toEqual(["org-1", PROVEDOR_DE_VOZ, ROTULO_DA_CHAVE_DE_VOZ]);
    expect(consultas[0]!.params).not.toContain("sk_abcdefgh1234");
    expect(consultas[0]!.sql).toMatch(/on conflict \(organization_id, provider, label\) do update/);
  });

  it("estado: cadastrada com os 4 últimos, ou ausente", async () => {
    expect(
      await estadoDaChaveDeVoz(bancoFalso([{ last4: "1234", validada_em: new Date("2026-09-28T13:00:00Z") }]).db, "org-1"),
    ).toEqual({ cadastrada: true, last4: "1234", validada_em: "2026-09-28T13:00:00.000Z" });
    expect(await estadoDaChaveDeVoz(bancoFalso([]).db, "org-1")).toEqual({ cadastrada: false, last4: null, validada_em: null });
  });

  it("decifra só a da própria organização; sem linha, null", async () => {
    const { db, consultas } = bancoFalso([{ c: Buffer.from("cifrado:sk_x"), iv: Buffer.alloc(12), tag: Buffer.alloc(16) }]);
    expect(await chaveDeVoz(db, "org-1")).toBe("sk_x");
    expect(consultas[0]!.params).toEqual(["org-1", PROVEDOR_DE_VOZ]);
    expect(await chaveDeVoz(bancoFalso([]).db, "org-1")).toBeNull();
  });

  it("decifragem que falha vira null, e o log leva só a classe do erro — nunca a mensagem", async () => {
    logs.warn.length = 0;
    const segredo = "sk_fragmento_do_segredo_9999";
    const db: Queryable = {
      query: (async () => {
        throw new TypeError(`falhou perto de ${segredo}`);
      }) as unknown as Queryable["query"],
    };
    expect(await chaveDeVoz(db, "org-1")).toBeNull();
    expect(logs.warn).toHaveLength(1);
    expect(logs.warn[0]!.ctx).toEqual({ organization_id: "org-1", classe: "TypeError" });
    expect(JSON.stringify(logs.warn)).not.toContain(segredo);
  });
});
