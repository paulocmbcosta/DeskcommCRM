// @vitest-environment node
/**
 * OS MENUS DE VOZ PELA ROTA (GET lista, POST cria): admin; o corpo passa pelo Zod
 * (nunca organização, nunca caminho); a gravação (`salvarMenuDaOrg`) recebe a
 * organização e o usuário da SESSÃO; cada falha volta com o status e a mensagem
 * certos — a falha do áudio de uma fala diz QUAL fala e manda gerar a prévia de
 * novo; a auditoria sai só no sucesso; a resposta é o menu que a TRANSAÇÃO
 * gravou (sem reler a lista); o POST aceita `Idempotency-Key` — a mesma chave
 * cria UM menu só; e a rota nunca CHAMA a ElevenLabs.
 *
 * "Nunca chama", e não "nem carrega": a rota importa `STATUS_DA_FALHA` e o armazém
 * de `servico-de-falas.ts`, que importa o cliente para a prévia. O que o D15
 * proíbe é a CHAMADA — então as duas chamadas de rede do cliente viram
 * armadilhas, e o `fetch` global é contado em todo caso deste arquivo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloElevenLabs from "@/lib/telefonia/elevenlabs";
import type * as ModuloMenus from "@/lib/telefonia/menus";
import type * as ModuloServico from "@/lib/telefonia/servico-de-falas";

const ORG = "22222222-2222-4222-8222-222222222222";
const USUARIO = "11111111-1111-4111-8111-111111111111";
const TIME = "44444444-4444-4444-8444-444444444444";
const MENU = "55555555-5555-4555-8555-555555555555";
const HASH = "a".repeat(64);
const POOL = vi.hoisted(() => ({ marca: "pool-da-rota" }));
const estado = vi.hoisted(() => ({ resultado: null as unknown, chamadasAElevenLabs: [] as string[] }));
const h = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "admin" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => POOL) }));
// O cliente com sessão só serve ao recibo de idempotência (a policy `idempotency_tenant` cobre a org).
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ from: h.from })) }));
vi.mock("@/lib/channels/telefonia/ari", () => ({ configAriDoAmbiente: vi.fn(() => ({ baseUrl: "http://a", senha: "x" })) }));
// Salvar o menu nunca CHAMA a ElevenLabs: as duas chamadas de rede do cliente viram armadilhas.
vi.mock("@/lib/telefonia/elevenlabs", async () => {
  const real = await vi.importActual<typeof ModuloElevenLabs>("@/lib/telefonia/elevenlabs");
  const armadilha = (nome: string) =>
    vi.fn(async () => {
      estado.chamadasAElevenLabs.push(nome);
      throw new Error(`salvar o menu chamou a ElevenLabs (${nome})`);
    });
  return { ...real, listarVozes: armadilha("listarVozes"), sintetizar: armadilha("sintetizar") };
});
// O `STATUS_DA_FALHA` é o DE VERDADE: o teste mede o código, não uma cópia dele.
vi.mock("@/lib/telefonia/servico-de-falas", async () => ({
  ...(await vi.importActual<typeof ModuloServico>("@/lib/telefonia/servico-de-falas")),
  armazemDaInstalacao: vi.fn(() => ({ marca: "armazem" })),
}));
vi.mock("@/lib/telefonia/menus", async () => ({
  ...(await vi.importActual<typeof ModuloMenus>("@/lib/telefonia/menus")),
  salvarMenuDaOrg: vi.fn(async () => estado.resultado),
  menusDaOrg: vi.fn(async () => [{ id: "55555555-5555-4555-8555-555555555555", nome: "Principal" }]),
  semanaDoMenu: vi.fn(async () => {
    throw new Error("o POST de um menu novo não lê semana nenhuma");
  }),
}));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { menusDaOrg, salvarMenuDaOrg, semanaDoMenu } from "@/lib/telefonia/menus";

import { GET, POST } from "./route";

const FALA = {
  id: "66666666-6666-4666-8666-666666666666",
  tipo: "menu",
  texto: "Para Suporte, digite 1.",
  voice_id: "v1",
  hash: HASH,
  status: "ready",
  erro: null,
  duracao_ms: 1500,
  atualizada_em: "2026-09-28T13:00:00.000Z",
};
const INVALIDA = { ...FALA, id: "77777777-7777-4777-8777-777777777777", tipo: "invalid", hash: "b".repeat(64) };
const MENU_SALVO = {
  id: MENU,
  nome: "Principal",
  time_padrao_id: TIME,
  time_padrao_nome: "Suporte",
  opcoes: [{ tecla: "1", time_id: TIME, time_nome: "Suporte" }],
  fala: FALA,
  fala_invalida: null,
  pronto: true,
  numeros: [],
};
const SEMANA_VAZIA = { total: 0, por_tecla: {}, sem_escolha: 0, tecla_errada: 0, desligou_no_menu: 0 };
const sucesso = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  id: MENU,
  menu: MENU_SALVO,
  fala: { fala: FALA, mudou: true },
  falaInvalida: null,
  falaInvalidaDescartada: null,
  ...extra,
});
const corpo = (extra: Record<string, unknown> = {}) => ({
  nome: "Principal",
  opcoes: [{ tecla: "1", time_id: TIME }],
  time_padrao_id: TIME,
  fala: { texto: "Para Suporte, digite 1.", hash: HASH },
  ...extra,
});
const post = (c: unknown, chave?: string) =>
  POST(
    new NextRequest("https://crm.exemplo.com.br/api/v1/telefonia/menus", {
      method: "POST",
      body: JSON.stringify(c),
      headers: chave ? { "Idempotency-Key": chave } : {},
    }),
  );

/** Os recibos de `idempotency_keys`, na mesma cadeia que o helper usa (como em message-templates). */
function recibos() {
  const gravados: Array<Record<string, unknown>> = [];
  h.from.mockImplementation(() => {
    let filtros: Array<[string, unknown]> = [];
    const builder = {
      select: () => builder,
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return builder;
      },
      gt: () => builder,
      maybeSingle: async () => {
        const achado = gravados.find((r) => filtros.every(([c, v]) => r[c] === v)) ?? null;
        filtros = [];
        return { data: achado, error: null };
      },
      insert: async (linha: Record<string, unknown>) => {
        gravados.push(linha);
        return { error: null };
      },
    };
    return builder;
  });
  return gravados;
}
const CHAVE = "88888888-8888-4888-8888-888888888888";
const erroDe = async (r: Response) =>
  ((await r.json()) as { error: { code: string; message: string; details?: { fala?: string } } }).error;
const acoes = () => vi.mocked(audit).mock.calls.map((c) => c[0].action);

const fetchContado = vi.fn(async () => new Response(null, { status: 599 }));

beforeEach(() => {
  estado.resultado = sucesso();
  estado.chamadasAElevenLabs = [];
  h.from.mockReset();
  vi.mocked(createClient).mockClear();
  fetchContado.mockClear();
  vi.stubGlobal("fetch", fetchContado);
  vi.mocked(audit).mockClear();
  vi.mocked(salvarMenuDaOrg).mockClear();
  vi.mocked(menusDaOrg).mockClear();
  vi.mocked(semanaDoMenu).mockClear();
  vi.mocked(requireRole).mockClear();
  vi.mocked(requireSupportWrite).mockClear();
});

afterEach(() => {
  // Em todo caso destas rotas: nenhuma chamada ao cliente da ElevenLabs, nenhuma ida à rede.
  expect(estado.chamadasAElevenLabs).toEqual([]);
  expect(fetchContado).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("GET /api/v1/telefonia/menus", () => {
  it("só admin; os menus da organização da SESSÃO, e se a telefonia é oferecida", async () => {
    const r = await GET();
    expect(r.status).toBe(200);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
    expect(vi.mocked(menusDaOrg).mock.calls[0]).toEqual([POOL, ORG]);
    expect(await r.json()).toMatchObject({ data: { oferecida: true, menus: [{ id: MENU }] } });
  });
});

describe("POST /api/v1/telefonia/menus", () => {
  it("só admin, e com a guarda de suporte", async () => {
    await post(corpo());
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("admin");
    expect(requireSupportWrite).toHaveBeenCalled();
  });

  it("suporte só acompanhando: a guarda barra no handler, antes do papel e de gravar", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(new Response(null, { status: 403 }) as never);
    const r = await post(corpo());
    expect(r.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(salvarMenuDaOrg).not.toHaveBeenCalled();
  });

  it("sucesso: grava com a organização e o usuário da SESSÃO, o pool da rota e o armazém; 201 com o menu; audita o menu e a fala", async () => {
    const r = await post(corpo());
    expect(r.status).toBe(201);
    // O menu da resposta é o da TRANSAÇÃO, com a semana vazia de um menu novo — sem reler a lista.
    expect(await r.json()).toEqual({ data: { menu: { ...MENU_SALVO, ultimos_7_dias: SEMANA_VAZIA } } });
    expect(menusDaOrg).not.toHaveBeenCalled();
    expect(semanaDoMenu).not.toHaveBeenCalled();
    // Sem a chave, nenhum recibo.
    expect(createClient).not.toHaveBeenCalled();
    expect(vi.mocked(salvarMenuDaOrg).mock.calls[0]![0]).toMatchObject({
      pool: POOL,
      armazem: { marca: "armazem" },
      organizationId: ORG,
      userId: USUARIO,
      id: null,
      entrada: { nome: "Principal", fala: { texto: "Para Suporte, digite 1.", hash: HASH }, fala_invalida: null },
    });
    expect(acoes()).toEqual(["phone.menu_saved", "phone.prompt_saved"]);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      organizationId: ORG,
      actorUserId: USUARIO,
      resourceType: "phone_menu",
      resourceId: MENU,
      metadata: { novo: true, time_padrao_id: TIME, com_fala_invalida: false },
    });
    expect(vi.mocked(audit).mock.calls[1]![0]).toMatchObject({
      resourceType: "phone_prompt",
      resourceId: FALA.id,
      metadata: { tipo: "menu", hash: HASH, menu_id: MENU },
    });
    // O texto da fala não vai para a auditoria.
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain("digite 1");
  });

  it("as duas falas mudaram: as duas são auditadas; nenhuma mudou: só o menu", async () => {
    estado.resultado = sucesso({ falaInvalida: { fala: INVALIDA, mudou: true } });
    await post(corpo({ fala_invalida: { texto: "Opção inválida.", hash: INVALIDA.hash } }));
    expect(acoes()).toEqual(["phone.menu_saved", "phone.prompt_saved", "phone.prompt_saved"]);

    vi.mocked(audit).mockClear();
    estado.resultado = sucesso({ fala: { fala: FALA, mudou: false } });
    await post(corpo());
    expect(acoes()).toEqual(["phone.menu_saved"]);
  });

  it("corpo com organização, caminho no lugar do hash ou tecla reservada → 422 genérico, sem gravar", async () => {
    for (const c of [
      corpo({ organization_id: "99999999-9999-4999-8999-999999999999" }),
      corpo({ fala: { texto: "Oi.", hash: `${ORG}/${HASH}.ulaw` } }),
      corpo({ opcoes: [{ tecla: "#", time_id: TIME }] }),
    ]) {
      const r = await post(c);
      expect(r.status).toBe(422);
      expect((await erroDe(r)).message).toBe("Campos inválidos.");
    }
    expect(salvarMenuDaOrg).not.toHaveBeenCalled();
  });

  it("texto da fala recusado pela NOSSA régua: mensagem própria, nunca 'a ElevenLabs recusou'", async () => {
    for (const c of [corpo({ fala: { texto: "   ", hash: HASH } }), corpo({ fala_invalida: { texto: "x".repeat(1001), hash: HASH } })]) {
      const e = await erroDe(await post(c));
      expect(e.code).toBe("validation_failed");
      expect(e.message).toMatch(/^Texto inválido/);
    }
    expect(salvarMenuDaOrg).not.toHaveBeenCalled();
    estado.resultado = { ok: false, motivo: "texto_recusado", fala: "invalida" };
    const e = await erroDe(await post(corpo()));
    expect(e.message).toMatch(/^Texto inválido/);
    expect(e.details).toEqual({ fala: "invalida" });
  });

  it.each([
    ["tecla_repetida", 422, /Cada tecla só pode levar a um time/],
    ["time_invalido", 422, /não existe nesta organização ou está arquivado/],
    ["gravacao_em_andamento", 409, /Outra gravação deste menu está em andamento/],
  ])("recusa do menu %s → %i, com a mensagem dela e sem auditar", async (motivo, status, mensagem) => {
    estado.resultado = { ok: false, motivo };
    const r = await post(corpo());
    expect(r.status).toBe(status);
    const e = await erroDe(r);
    expect(e.code).toBe(motivo);
    expect(e.message).toMatch(mensagem);
    expect(audit).not.toHaveBeenCalled();
  });

  it("o áudio de uma fala sumiu do Storage: 422 previa_ausente, dizendo QUAL fala e mandando gerar a prévia de novo", async () => {
    estado.resultado = { ok: false, motivo: "previa_ausente", fala: "menu" };
    let r = await post(corpo());
    expect(r.status).toBe(422);
    let e = await erroDe(r);
    expect(e.code).toBe("previa_ausente");
    expect(e.message).toBe("O áudio da fala do menu não foi encontrado. Gere a prévia de novo e salve.");
    expect(e.details).toEqual({ fala: "menu" });

    estado.resultado = { ok: false, motivo: "previa_ausente", fala: "invalida" };
    r = await post(corpo());
    e = await erroDe(r);
    expect(e.message).toBe("O áudio da fala de opção inválida não foi encontrado. Gere a prévia de novo e salve.");
    expect(e.details).toEqual({ fala: "invalida" });
    expect(audit).not.toHaveBeenCalled();
  });

  it("o Storage está fora: 502 armazenamento, dizendo qual fala, tentar de novo e, se continuar, gerar a prévia de novo", async () => {
    estado.resultado = { ok: false, motivo: "armazenamento", fala: "menu" };
    const r = await post(corpo());
    expect(r.status).toBe(502);
    const e = await erroDe(r);
    expect(e.code).toBe("armazenamento");
    expect(e.message).toMatch(/áudio da fala do menu/);
    expect(e.message).toMatch(/gere a prévia de novo/);
    // Não é a mensagem da prévia ("não foi possível GUARDAR"): salvar só confere.
    expect(e.message).not.toMatch(/guardar/);
  });

  it("prévia desatualizada ou sem voz: o status e a mensagem da falha da fala, com qual fala", async () => {
    estado.resultado = { ok: false, motivo: "previa_desatualizada", fala: "invalida" };
    let r = await post(corpo());
    expect(r.status).toBe(422);
    let e = await erroDe(r);
    expect(e.code).toBe("previa_desatualizada");
    expect(e.message).toMatch(/Gere a prévia de novo antes de salvar/);
    expect(e.details).toEqual({ fala: "invalida" });

    estado.resultado = { ok: false, motivo: "sem_voz", fala: "menu" };
    r = await post(corpo());
    e = await erroDe(r);
    expect([r.status, e.code]).toEqual([422, "sem_voz"]);
  });
});

describe("POST /api/v1/telefonia/menus — Idempotency-Key", () => {
  it("a mesma chave e o mesmo corpo duas vezes: UM menu criado, a mesma resposta, uma auditoria", async () => {
    const gravados = recibos();
    const primeira = await post(corpo(), CHAVE);
    const segunda = await post(corpo(), CHAVE);

    expect([primeira.status, segunda.status]).toEqual([201, 201]);
    expect(salvarMenuDaOrg).toHaveBeenCalledTimes(1);
    expect(await segunda.json()).toEqual(await primeira.json());
    expect(acoes()).toEqual(["phone.menu_saved", "phone.prompt_saved"]);
    expect(gravados).toHaveLength(1);
    expect(gravados[0]).toMatchObject({ organization_id: ORG, key: CHAVE, endpoint: "/api/v1/telefonia/menus", status_code: 201 });
  });

  it("a mesma chave com OUTRO corpo: 409 idempotency_conflict, sem criar de novo", async () => {
    recibos();
    await post(corpo(), CHAVE);
    const conflito = await post(corpo({ nome: "Outro" }), CHAVE);
    expect(conflito.status).toBe(409);
    expect((await erroDe(conflito)).code).toBe("idempotency_conflict");
    expect(salvarMenuDaOrg).toHaveBeenCalledTimes(1);
  });

  it("recusa não vira recibo: a mesma chave tenta de novo depois de gerar a prévia, e cria", async () => {
    const gravados = recibos();
    estado.resultado = { ok: false, motivo: "previa_ausente", fala: "menu" };
    expect((await post(corpo(), CHAVE)).status).toBe(422);
    expect(gravados).toHaveLength(0);

    estado.resultado = sucesso();
    expect((await post(corpo(), CHAVE)).status).toBe(201);
    expect(salvarMenuDaOrg).toHaveBeenCalledTimes(2);
    expect(gravados).toHaveLength(1);
  });

  it("chave que não é UUID: 400 antes de qualquer efeito, e sem recibo", async () => {
    const gravados = recibos();
    const r = await post(corpo(), "nao-e-uuid");
    expect(r.status).toBe(400);
    expect(salvarMenuDaOrg).not.toHaveBeenCalled();
    expect(gravados).toHaveLength(0);
  });
});
