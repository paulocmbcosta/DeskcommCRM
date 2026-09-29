// @vitest-environment node
/**
 * A LEITURA DOS AVISOS: qualquer membro lê (a régua é viewer), mas cada papel
 * recebe o que usa —
 *  - viewer e agent: só a FAIXA (`ligados`: time, prazo e arquivado dos avisos
 *    vigentes). Nem quem ligou, nem o texto, nem nome pedido a ninguém;
 *  - manager e admin: a faixa e a lista COMPLETA (`times`), com quem ligou pelo
 *    nome cadastrado — sem ele, "alguém da equipe", nunca o e-mail.
 * A organização é a da SESSÃO; o relógio é o da requisição; sem a telefonia
 * oferecida na instalação, as listas vêm vazias sem tocar no banco.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloEmergencias from "@/lib/telefonia/emergencias";

const ORG = "22222222-2222-4222-8222-222222222222";
const POOL = { pool: "da-rota" };
const TIME = "44444444-4444-4444-8444-444444444444";
const estado = vi.hoisted(() => ({
  ari: { baseUrl: "http://asterisk:8088", senha: "x" } as unknown,
  papel: "viewer",
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "bia@exemplo.com", full_name: "Bia", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: estado.papel },
  })),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({ pool: "da-rota" })) }));
vi.mock("@/lib/channels/telefonia/ari", () => ({ configAriDoAmbiente: vi.fn(() => estado.ari) }));
vi.mock("@/lib/users/nome-do-atendente", () => ({
  nomesDosAtendentes: vi.fn(async () => new Map()),
  nomesDeExibicao: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/telefonia/emergencias", async () => {
  const real = await vi.importActual<typeof ModuloEmergencias>("@/lib/telefonia/emergencias");
  const COMPLETO = {
    team_id: "44444444-4444-4444-8444-444444444444",
    time_nome: "Suporte",
    arquivado: false,
    ativa: true,
    desde: "2026-09-28T13:00:00.000Z",
    expira_em: "2026-09-28T15:00:00.000Z",
    ligada_por: "Ana",
    fala: { id: "f1", tipo: "emergency", texto: "Instabilidade.", voice_id: "v", hash: "h", status: "ready", erro: null, duracao_ms: 1, atualizada_em: "x" },
  };
  return {
    ...real,
    avisosDaOrg: vi.fn(async () => [COMPLETO]),
    avisosLigados: vi.fn(async () => [
      { team_id: "44444444-4444-4444-8444-444444444444", time_nome: "Suporte", expira_em: "2026-09-28T15:00:00.000Z", arquivado: false },
    ]),
  };
});

import { requireRole } from "@/lib/auth/require-role";
import { avisosDaOrg, avisosLigados } from "@/lib/telefonia/emergencias";
import { nomesDeExibicao, nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

import { GET } from "./route";

const FAIXA = [{ team_id: TIME, time_nome: "Suporte", expira_em: "2026-09-28T15:00:00.000Z", arquivado: false }];
/** A requisição como o `apiClient` a manda; `busca` é a query string (`?so=ligados`). */
const pedido = (busca = "") => new NextRequest(`http://crm.teste/api/v1/telefonia/emergencias${busca}`);
const corpoDe = async (r: Response) => ((await r.json()) as { data: Record<string, unknown> }).data;

beforeEach(() => {
  estado.ari = { baseUrl: "http://asterisk:8088", senha: "x" };
  estado.papel = "viewer";
  vi.mocked(requireRole).mockClear();
  vi.mocked(avisosDaOrg).mockClear();
  vi.mocked(avisosLigados).mockClear();
  vi.mocked(nomesDosAtendentes).mockClear();
});

describe("GET /api/v1/telefonia/emergencias", () => {
  it("qualquer membro lê: a régua é viewer", async () => {
    expect((await GET(pedido())).status).toBe(200);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("viewer");
  });

  it.each(["viewer", "agent"])("%s recebe SÓ a faixa (time, prazo, arquivado) — sem quem ligou, sem texto, sem nome pedido", async (papel) => {
    estado.papel = papel;
    const antes = Date.now();
    const corpo = await corpoDe(await GET(pedido()));
    expect(corpo).toEqual({ oferecida: true, pode_mudar: false, ligados: FAIXA, times: null });
    expect(JSON.stringify(corpo)).not.toMatch(/ligada_por|Instabilidade|"fala"/);
    const [pool, org, agora] = vi.mocked(avisosLigados).mock.calls[0]!;
    expect(pool).toEqual(POOL);
    expect(org).toBe(ORG);
    expect(agora.getTime()).toBeGreaterThanOrEqual(antes);
    expect(avisosDaOrg).not.toHaveBeenCalled();
    expect(nomesDosAtendentes).not.toHaveBeenCalled();
    expect(nomesDeExibicao).not.toHaveBeenCalled();
  });

  it.each(["manager", "admin"])(
    "%s recebe a faixa e a lista completa; o nome é o CADASTRADO (nomesDosAtendentes), e sem ele 'alguém da equipe'",
    async (papel) => {
      estado.papel = papel;
      const corpo = await corpoDe(await GET(pedido()));
      expect(corpo.pode_mudar).toBe(true);
      expect(corpo.ligados).toEqual(FAIXA);
      expect((corpo.times as unknown[])[0]).toMatchObject({ team_id: TIME, ligada_por: "Ana", fala: { texto: "Instabilidade." } });
      const [pool, org, , nomes, semNome] = vi.mocked(avisosDaOrg).mock.calls[0]!;
      expect(pool).toEqual(POOL);
      expect(org).toBe(ORG);
      // Só o nome cadastrado: a régua de exibição (que cai para o começo do e-mail) não serve aqui.
      expect(nomes).toBe(nomesDosAtendentes);
      expect(semNome).toBe("alguém da equipe");
      expect(avisosLigados).not.toHaveBeenCalled();
    },
  );

  describe("?so=ligados — a leitura da FAIXA, que roda 1 vez por minuto em cada aba", () => {
    it.each([
      ["viewer", false],
      ["agent", false],
      ["manager", true],
      ["admin", true],
    ])("%s recebe só a faixa e o `pode_mudar`; nada de lista completa nem de nome pedido", async (papel, podeMudar) => {
      estado.papel = papel;
      const corpo = await corpoDe(await GET(pedido("?so=ligados")));
      expect(corpo).toEqual({ oferecida: true, pode_mudar: podeMudar, ligados: FAIXA, times: null });
      const [pool, org] = vi.mocked(avisosLigados).mock.calls[0]!;
      expect(pool).toEqual(POOL);
      expect(org).toBe(ORG);
      expect(avisosDaOrg).not.toHaveBeenCalled();
      expect(nomesDosAtendentes).not.toHaveBeenCalled();
      // O acesso segue o mesmo: a régua é viewer, e o parâmetro só REDUZ a resposta.
      expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("viewer");
    });

    it.each(["viewer", "agent"])("para %s, a resposta é a MESMA com e sem o parâmetro", async (papel) => {
      estado.papel = papel;
      const sem = await corpoDe(await GET(pedido()));
      const com = await corpoDe(await GET(pedido("?so=ligados")));
      expect(com).toEqual(sem);
    });

    it("sem a telefonia na instalação: listas vazias, sem ler o banco", async () => {
      estado.ari = null;
      estado.papel = "admin";
      expect(await corpoDe(await GET(pedido("?so=ligados")))).toEqual({ oferecida: false, pode_mudar: true, ligados: [], times: null });
      expect(avisosLigados).not.toHaveBeenCalled();
      expect(avisosDaOrg).not.toHaveBeenCalled();
    });

    it.each(["?so=tudo", "?so=", "?so=ligados&so=times"])("valor desconhecido (%s) é 400, sem ler o banco", async (busca) => {
      estado.papel = "admin";
      const r = await GET(pedido(busca));
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ error: { code: "validation_failed" } });
      expect(avisosLigados).not.toHaveBeenCalled();
      expect(avisosDaOrg).not.toHaveBeenCalled();
    });
  });

  it("telefonia não oferecida nesta instalação: listas vazias, sem ler o banco", async () => {
    estado.ari = null;
    expect(await corpoDe(await GET(pedido()))).toEqual({ oferecida: false, pode_mudar: false, ligados: [], times: null });
    estado.papel = "admin";
    expect(await corpoDe(await GET(pedido()))).toEqual({ oferecida: false, pode_mudar: true, ligados: [], times: [] });
    expect(avisosDaOrg).not.toHaveBeenCalled();
    expect(avisosLigados).not.toHaveBeenCalled();
  });
});
