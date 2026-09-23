/**
 * Dois números oficiais de CONTAS (WABAs) diferentes na mesma organização — o
 * modelo é da conta, e cada número só enxerga e só envia os da sua.
 *
 * Medido em 2026-09-23, na primeira organização com dois números oficiais: o
 * canal oficial grava a conta (`waba_id`) e não a conexão, e duas leituras
 * ignoravam a conta:
 *
 *   - o seletor de modelos (`modelosParaEnvio`) oferecia ao número A os modelos
 *     da conta do número B — que a plataforma recusa, porque o modelo não existe
 *     na conta de quem envia;
 *   - o envio (`sendTemplateForSession`) buscava o modelo por nome+idioma e, com
 *     o mesmo nome nas duas contas, o `maybeSingle()` casava duas linhas.
 *
 * Para ver morder: tire o ramo `wabaDaSessao` de `modelos-para-envio.ts`, ou o
 * `.eq("waba_id", creds.wabaId)` de `send-template-for-session.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { modelosParaEnvio } from "@/lib/channels/modelos-para-envio";
import { sendTemplateForSession } from "@/lib/channels/meta/send-template-for-session";

vi.mock("@/lib/channels/meta/credentials", () => ({
  resolveMetaCreds: vi.fn(async () => ({
    phoneNumberId: "pn-b",
    token: "tok",
    graphVersion: "v21.0",
    wabaId: "222",
    source: "session",
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/meta/send-template", () => ({
  sendTemplate: vi.fn(async () => ({ sent: true, externalId: "wamid.1" })),
}));

const ORG = "00000000-0000-4000-8000-000000000a01";

/** Um client que registra cada filtro pedido e devolve o que a tabela pedir. */
function dbQueRegistra(sessao: Record<string, unknown>) {
  const filtros: Array<[string, string, unknown]> = [];
  const db = {
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (c: string, v: unknown) => (filtros.push([tabela, `eq:${c}`, v]), q);
      q.or = (v: string) => (filtros.push([tabela, "or", v]), q);
      q.order = () => q;
      q.maybeSingle = async () =>
        tabela === "channel_sessions" ? { data: sessao, error: null } : { data: null, error: null };
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
      return q;
    },
  } as unknown as SupabaseClient;
  return { db, filtros };
}

beforeEach(() => vi.clearAllMocks());

describe("o seletor de modelos só oferece os da CONTA do número", () => {
  it("⭐ número oficial: órfão só vale se for da conta dele", async () => {
    const { db, filtros } = dbQueRegistra({ id: "s-b", provider: "meta_cloud", meta_waba_id: "222" });
    await modelosParaEnvio(db, ORG, "s-b");

    const or = filtros.find(([t, k]) => t === "meta_templates" && k === "or")?.[2];
    expect(or).toBe("channel_session_id.eq.s-b,and(channel_session_id.is.null,waba_id.eq.222)");
  });

  it("conexão sem conta (canal intermediado): o filtro de sempre", async () => {
    const { db, filtros } = dbQueRegistra({ id: "s-z", provider: "zernio", meta_waba_id: null });
    await modelosParaEnvio(db, ORG, "s-z");

    const or = filtros.find(([t, k]) => t === "meta_templates" && k === "or")?.[2];
    expect(or).toBe("channel_session_id.eq.s-z,channel_session_id.is.null");
  });

  it("conta com caractere fora de dígito não entra na expressão do filtro", async () => {
    const { db, filtros } = dbQueRegistra({ id: "s-x", provider: "meta_cloud", meta_waba_id: "1),or(x" });
    await modelosParaEnvio(db, ORG, "s-x");

    const or = String(filtros.find(([t, k]) => t === "meta_templates" && k === "or")?.[2]);
    expect(or).not.toContain("1),or(x");
  });
});

describe("o envio de modelo procura na CONTA de quem envia", () => {
  it("⭐ a busca do espelho filtra `waba_id` pela conta do número", async () => {
    const { db, filtros } = dbQueRegistra({});
    await sendTemplateForSession(db, {
      organizationId: ORG,
      sessionRef: "pn-b",
      to: "5561999999999",
      name: "boas_vindas",
      language: "pt_BR",
      values: {},
    }).catch(() => undefined);

    expect(filtros).toContainEqual(["meta_templates", "eq:waba_id", "222"]);
  });
});
