// @vitest-environment node
/**
 * O AVISO DE INSTABILIDADE PELA ROTA (desenho da fase 2, D7/D8, §4 e §6.3):
 * gerente ou admin; só com a telefonia oferecida na instalação; a organização é a
 * da SESSÃO; prévia que não confere não liga nada, e cada recusa tem a mensagem
 * do LIGAR (nada de "guardar"/"salvar"); o time arquivado é recusado com
 * mensagem própria; o prazo sai da duração escolhida (2 h por padrão, ou "até eu
 * desligar"); ligar audita a duração, se o texto mudou e o período substituído
 * (com quem o ligou), desligar audita quando havia o que desligar.
 *
 * A transação (trava da linha do time, decisão de novo sob ela) é da camada de
 * banco, `lib/telefonia/emergencias.ts`, provada em emergencias.test.ts e no
 * Postgres real (tests/invariants/telefonia-aviso-no-banco.test.ts). Aqui ela é
 * uma porta: o que se prova é o que a ROTA faz com cada desfecho. Que ligar não
 * alcança a ElevenLabs, com a camada de banco DE VERDADE, está em
 * ligar-sem-elevenlabs.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as ModuloEmergencias from "@/lib/telefonia/emergencias";
import type * as ModuloArmazem from "@/lib/telefonia/armazem";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const USUARIO = "11111111-1111-4111-8111-111111111111";
const BRUNO = "11111111-1111-4111-8111-11111111111b";
const TIME = "44444444-4444-4444-8444-444444444444";
const HASH = "c".repeat(64);
const estado = vi.hoisted(() => ({
  ligar: null as unknown,
  desligar: null as unknown,
  ari: { baseUrl: "http://asterisk:8088", senha: "x" } as unknown,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "ana@exemplo.com", full_name: "Ana", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "manager" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({ pool: "da-rota" })) }));
vi.mock("@/lib/channels/telefonia/ari", () => ({ configAriDoAmbiente: vi.fn(() => estado.ari) }));
// O `STATUS_DA_FALHA` é o DE VERDADE (vocabulario.ts, sem mock): é ele que decide 409, 422 e 502.
vi.mock("@/lib/telefonia/armazem", async () => {
  const real = await vi.importActual<typeof ModuloArmazem>("@/lib/telefonia/armazem");
  return { ...real, armazemDaInstalacao: vi.fn(() => ({ armazem: "da-instalacao" })) };
});
vi.mock("@/lib/telefonia/emergencias", async () => {
  const real = await vi.importActual<typeof ModuloEmergencias>("@/lib/telefonia/emergencias");
  return {
    ...real,
    ligarAvisoDoTime: vi.fn(async () => estado.ligar),
    desligarAvisoDoTime: vi.fn(async () => estado.desligar),
  };
});

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { desligarAvisoDoTime, ligarAvisoDoTime } from "@/lib/telefonia/emergencias";
import { MENSAGEM_DO_TEXTO_INVALIDO } from "@/lib/telefonia/vocabulario";

import { DELETE, PUT } from "./route";

const FALA = {
  id: "66666666-6666-4666-8666-666666666666",
  tipo: "emergency",
  texto: "Instabilidade.",
  voice_id: "v1",
  hash: HASH,
  status: "ready",
  erro: null,
  duracao_ms: 2000,
  atualizada_em: "2026-09-28T13:00:00.000Z",
};
const PREVIA = { texto: "Instabilidade.", hash: HASH };
const params = (teamId = TIME) => ({ params: Promise.resolve({ teamId }) });
const url = (teamId = TIME) => `https://crm.exemplo.com.br/api/v1/telefonia/emergencias/${teamId}`;
const ligar = (corpo: unknown, teamId = TIME) =>
  PUT(new NextRequest(url(teamId), { method: "PUT", body: JSON.stringify(corpo) }), params(teamId));
const desligar = (teamId = TIME) => DELETE(new NextRequest(url(teamId), { method: "DELETE" }), params(teamId));
const erroDe = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
const acoes = () => vi.mocked(audit).mock.calls.map((c) => c[0].action);
const pedidoDoLigar = () => vi.mocked(ligarAvisoDoTime).mock.calls[0]![0];

beforeEach(() => {
  estado.ligar = { ok: true, time: { id: TIME, nome: "Suporte" }, fala: FALA, mudou: true, anterior: null };
  estado.desligar = { ok: true, desligado: { desde: "2026-09-28T13:00:00.000Z", expiraEm: null, ligadoPor: BRUNO } };
  estado.ari = { baseUrl: "http://asterisk:8088", senha: "x" };
  vi.mocked(audit).mockClear();
  vi.mocked(ligarAvisoDoTime).mockClear();
  vi.mocked(desligarAvisoDoTime).mockClear();
  vi.mocked(requireRole).mockClear();
  vi.mocked(requireSupportWrite).mockClear();
});

describe("PUT /api/v1/telefonia/emergencias/[teamId] — ligar", () => {
  it("gerente ou admin (a régua é manager), com a guarda de suporte", async () => {
    await ligar({ fala: PREVIA, duracao: "1h" });
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
    expect(requireSupportWrite).toHaveBeenCalledTimes(1);
  });

  it("id do time fora do formato → 404, sem chegar ao banco", async () => {
    expect((await ligar({ fala: PREVIA }, "nao-e-uuid")).status).toBe(404);
    expect(ligarAvisoDoTime).not.toHaveBeenCalled();
  });

  it("time de outra organização (ou arquivado) → 404, e nada auditado", async () => {
    estado.ligar = { ok: false, motivo: "nao_encontrado" };
    const r = await ligar({ fala: PREVIA });
    expect(r.status).toBe(404);
    expect((await erroDe(r)).code).toBe("not_found");
    expect(audit).not.toHaveBeenCalled();
  });

  it("time ARQUIVADO → 409 com mensagem própria (ele não recebe ligações), e nada auditado", async () => {
    estado.ligar = { ok: false, motivo: "time_arquivado" };
    const r = await ligar({ fala: PREVIA });
    expect(r.status).toBe(409);
    expect(await erroDe(r)).toMatchObject({
      code: "time_arquivado",
      message: "Este time está arquivado e não recebe ligações: o aviso não pode ser ligado nele.",
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ["previa_desatualizada", 422, "A prévia não corresponde a este texto ou à voz atual. Gere a prévia de novo."],
    ["previa_ausente", 422, "O áudio deste texto não foi encontrado. Gere a prévia de novo antes de ligar."],
    [
      "armazenamento",
      502,
      "Não conseguimos conferir o áudio do aviso agora. Tente ligar de novo; se continuar, use o texto já salvo.",
    ],
  ] as const)("a fala recusada ao LIGAR (%s) → %i com a mensagem do ligar — nada de 'guardar' ou 'salvar'", async (motivo, status, mensagem) => {
    estado.ligar = { ok: false, motivo };
    const r = await ligar({ fala: PREVIA });
    expect(r.status).toBe(status);
    const erro = await erroDe(r);
    expect(erro).toMatchObject({ code: motivo, message: mensagem });
    expect(erro.message).not.toMatch(/guardar|salvar/i);
    expect(audit).not.toHaveBeenCalled();
  });

  it("a linha do time presa por outra transação (55P03) → 409, sem culpar 'o aviso'", async () => {
    estado.ligar = { ok: false, motivo: "gravacao_em_andamento" };
    const r = await ligar({ fala: PREVIA });
    expect(r.status).toBe(409);
    expect((await erroDe(r)).message).toBe("Este time está sendo alterado por outra pessoa agora. Tente de novo em instantes.");
    expect(audit).not.toHaveBeenCalled();
  });

  it("telefonia não oferecida nesta instalação → 409, sem chegar ao banco", async () => {
    estado.ari = null;
    const r = await ligar({ fala: PREVIA });
    expect(r.status).toBe(409);
    expect((await erroDe(r)).code).toBe("telefonia_nao_oferecida");
    expect(ligarAvisoDoTime).not.toHaveBeenCalled();
  });

  it("texto recusado pela NOSSA régua nunca diz que a ElevenLabs recusou", async () => {
    estado.ligar = { ok: false, motivo: "texto_recusado" };
    const r = await ligar({ fala: PREVIA });
    expect(r.status).toBe(422);
    expect(await erroDe(r)).toMatchObject({ code: "validation_failed", message: MENSAGEM_DO_TEXTO_INVALIDO });
    // E o texto longo demais nem passa do Zod — mesma mensagem.
    const longo = await ligar({ fala: { texto: "x".repeat(1001), hash: HASH } });
    expect(await erroDe(longo)).toMatchObject({ code: "validation_failed", message: MENSAGEM_DO_TEXTO_INVALIDO });
  });

  it("sem a prévia no corpo, duração fora da lista ou organização no corpo → 422, sem chegar ao banco", async () => {
    expect((await ligar({ duracao: "1h" })).status).toBe(422);
    expect((await ligar({ fala: PREVIA, duracao: "3h" })).status).toBe(422);
    expect((await ligar({ fala: PREVIA, organization_id: OUTRA_ORG })).status).toBe(422);
    expect(ligarAvisoDoTime).not.toHaveBeenCalled();
  });

  it("liga com o hash da prévia, a organização da SESSÃO e o prazo de 2 h por padrão; audita o ligar e a fala nova", async () => {
    const r = await ligar({ fala: PREVIA });
    expect(r.status).toBe(200);
    const pedido = pedidoDoLigar();
    expect(pedido).toMatchObject({
      pool: { pool: "da-rota" },
      armazem: { armazem: "da-instalacao" },
      organizationId: ORG,
      userId: USUARIO,
      teamId: TIME,
      fala: PREVIA,
    });
    expect(pedido.expiraEm!.getTime() - pedido.desde.getTime()).toBe(2 * 3_600_000);

    expect(acoes()).toEqual(["phone.emergency_activated", "phone.prompt_saved"]);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      organizationId: ORG,
      actorUserId: USUARIO,
      resourceType: "attendance_team",
      resourceId: TIME,
      metadata: { duracao: "2h", texto_mudou: true, fala_id: FALA.id, expira_em: pedido.expiraEm!.toISOString(), anterior: null },
    });
    expect(vi.mocked(audit).mock.calls[1]![0]).toMatchObject({
      resourceType: "phone_prompt",
      resourceId: FALA.id,
      metadata: { tipo: "emergency", hash: HASH, team_id: TIME },
    });

    const corpo = (await r.json()) as { data: { aviso: Record<string, unknown> } };
    expect(corpo.data.aviso).toEqual({
      team_id: TIME,
      time_nome: "Suporte",
      arquivado: false,
      ativa: true,
      desde: pedido.desde.toISOString(),
      expira_em: pedido.expiraEm!.toISOString(),
      ligada_por: "Ana",
      fala: FALA,
    });
  });

  it("o aviso de antes, sem mudança no texto: liga, e só o ligar é auditado — dizendo que o texto não mudou", async () => {
    estado.ligar = { ok: true, time: { id: TIME, nome: "Suporte" }, fala: FALA, mudou: false, anterior: null };
    await ligar({ fala: PREVIA, duracao: "4h" });
    expect(acoes()).toEqual(["phone.emergency_activated"]);
    expect(vi.mocked(audit).mock.calls[0]![0].metadata).toMatchObject({ duracao: "4h", texto_mudou: false });
    const pedido = pedidoDoLigar();
    expect(pedido.expiraEm!.getTime() - pedido.desde.getTime()).toBe(4 * 3_600_000);
  });

  it("'até eu desligar' liga sem prazo", async () => {
    const r = await ligar({ fala: PREVIA, duracao: "indefinida" });
    expect(pedidoDoLigar().expiraEm).toBeNull();
    expect(vi.mocked(audit).mock.calls[0]![0].metadata).toMatchObject({ duracao: "indefinida", expira_em: null });
    expect(((await r.json()) as { data: { aviso: { expira_em: unknown } } }).data.aviso.expira_em).toBeNull();
  });

  it("religar por cima (o mesmo texto e a mesma duração estendem o prazo e trocam o autor): o período de antes, com QUEM o ligou, vai na auditoria", async () => {
    const anterior = { desde: "2026-09-28T10:00:00.000Z", expiraEm: "2026-09-28T11:00:00.000Z", ligadoPor: BRUNO };
    estado.ligar = { ok: true, time: { id: TIME, nome: "Suporte" }, fala: FALA, mudou: false, anterior };
    await ligar({ fala: PREVIA });
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      actorUserId: USUARIO,
      metadata: { anterior: { desde: anterior.desde, expira_em: anterior.expiraEm, ligado_por: BRUNO } },
    });
  });

  it("quem ligou sem nome cadastrado aparece como 'alguém da equipe' — nunca o e-mail nem o começo dele", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: true,
      user: { id: USUARIO, email: "ana.souza@exemplo.com", full_name: null, idioma: "pt-BR" },
      org: { orgId: ORG, name: "Org", role: "manager" },
    } as never);
    const r = await ligar({ fala: PREVIA });
    const aviso = ((await r.json()) as { data: { aviso: { ligada_por: string } } }).data.aviso;
    expect(aviso.ligada_por).toBe("alguém da equipe");
    expect(JSON.stringify(aviso)).not.toMatch(/ana\.souza/);
  });
});

describe("DELETE /api/v1/telefonia/emergencias/[teamId] — desligar", () => {
  it("gerente ou admin, com a guarda de suporte; a organização é a da sessão", async () => {
    await desligar();
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
    expect(requireSupportWrite).toHaveBeenCalledTimes(1);
    const chamada = vi.mocked(desligarAvisoDoTime).mock.calls[0]!;
    expect(chamada.slice(0, 3)).toEqual([{ pool: "da-rota" }, ORG, TIME]);
    expect(chamada[3]).toBeInstanceOf(Date);
  });

  it("estava ligado: desliga e audita o período que foi desligado, com quem o tinha ligado", async () => {
    estado.desligar = {
      ok: true,
      desligado: { desde: "2026-09-28T13:00:00.000Z", expiraEm: "2026-09-28T15:00:00.000Z", ligadoPor: BRUNO },
    };
    const r = await desligar();
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toEqual({ desligado: true });
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "phone.emergency_deactivated",
      organizationId: ORG,
      actorUserId: USUARIO,
      resourceType: "attendance_team",
      resourceId: TIME,
      metadata: { ligado_em: "2026-09-28T13:00:00.000Z", expiraria_em: "2026-09-28T15:00:00.000Z", ligado_por: BRUNO },
    });
  });

  it("já estava desligado (ou já vencido, que é da passada do worker): nada mudou, nada a auditar", async () => {
    estado.desligar = { ok: true, desligado: null };
    const r = await desligar();
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toEqual({ desligado: false });
    expect(audit).not.toHaveBeenCalled();
  });

  it("telefonia não oferecida nesta instalação → 409, sem chegar ao banco", async () => {
    estado.ari = null;
    const r = await desligar();
    expect(r.status).toBe(409);
    expect((await erroDe(r)).code).toBe("telefonia_nao_oferecida");
    expect(desligarAvisoDoTime).not.toHaveBeenCalled();
  });

  it("time de outra organização → 404; id fora do formato → 404 sem banco; trava ocupada → 409", async () => {
    estado.desligar = { ok: false, motivo: "nao_encontrado" };
    expect((await desligar()).status).toBe(404);
    vi.mocked(desligarAvisoDoTime).mockClear();
    expect((await desligar("x")).status).toBe(404);
    expect(desligarAvisoDoTime).not.toHaveBeenCalled();
    estado.desligar = { ok: false, motivo: "gravacao_em_andamento" };
    expect((await desligar()).status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });
});
