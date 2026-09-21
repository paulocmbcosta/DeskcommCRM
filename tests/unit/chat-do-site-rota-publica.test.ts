import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AS ROTAS PÚBLICAS DO CHAT DO SITE — as únicas do produto chamadas por `fetch`
 * a partir do site de um terceiro, sem cookie e sem login.
 *
 * O que se prende aqui é a CASCA: quem entra, quem é recusado e com que cara. A
 * regra de negócio (o que se grava, o que se lê) tem teste próprio contra o
 * banco em memória. Casca de rota anônima errada é a que vira incidente: CORS
 * faltando numa resposta de erro faz o widget ver "falha de rede" em vez de 429;
 * um 404 que distingue "chave malformada" de "chave inexistente" ensina a
 * enumerar.
 */

const CHAVE = "wc_abcdefghijklmnopqrstuvwx";
const TOKEN = "wv_" + "A".repeat(43);

const canalPelaChave = vi.fn();
const registrarSinal = vi.fn(async () => undefined);
const checkRateLimit = vi.fn(async (_b: string, limit: number, w: number) => ({
  allowed: true,
  count: 1,
  limit,
  window_sec: w,
}));
const ingerir = vi.fn();
const conversaDoVisitante = vi.fn();
const ler = vi.fn(async () => []);

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: (b: string, l: number, w: number) => checkRateLimit(b, l, w),
}));
vi.mock("@/lib/channels/chat-do-site/canal", () => ({
  canalPelaChave: (...a: unknown[]) => canalPelaChave(...a),
  registrarSinalDoWidget: (...a: unknown[]) => registrarSinal(...(a as [])),
}));
vi.mock("@/lib/channels/chat-do-site/entrada", () => ({
  ingerirMensagemDoVisitante: (...a: unknown[]) => ingerir(...a),
  conversaDoVisitante: (...a: unknown[]) => conversaDoVisitante(...a),
}));
vi.mock("@/lib/channels/chat-do-site/leitura", () => ({
  lerMensagensDoVisitante: (...a: unknown[]) => ler(...(a as [])),
}));

const { CONFIG_PADRAO_DO_WIDGET } = await import("@/lib/channels/chat-do-site/config");
const { LIMITES } = await import("@/lib/channels/chat-do-site/http");
const rotaConfig = await import("@/app/api/v1/site-chat/[chave]/config/route");
const rotaMensagens = await import("@/app/api/v1/site-chat/[chave]/messages/route");

const canal = (dominios: string[] = []) => ({
  id: "canal-1",
  organizationId: "org-a",
  nome: "Site",
  config: { ...CONFIG_PADRAO_DO_WIDGET, dominios_permitidos: dominios },
  ultimoSinal: null,
});

const ctx = (chave = CHAVE) => ({ params: Promise.resolve({ chave }) });

function pedido(metodo: string, caminho: string, opts: { headers?: Record<string, string>; corpo?: unknown } = {}) {
  return new Request(`https://crm.exemplo.com/api/v1/site-chat/${CHAVE}/${caminho}`, {
    method: metodo,
    headers: { origin: "https://loja.exemplo.com", "content-type": "application/json", ...(opts.headers ?? {}) },
    body: opts.corpo === undefined ? undefined : JSON.stringify(opts.corpo),
  });
}

const corpoValido = { body: "oi", client_message_id: "3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f" };

beforeEach(() => {
  vi.clearAllMocks();
  canalPelaChave.mockResolvedValue(canal());
});

describe("CORS — em TODA resposta, inclusive nas de erro", () => {
  it("o preflight responde sem tocar em banco", async () => {
    const r = rotaMensagens.OPTIONS();
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("access-control-allow-headers")).toContain("X-Visitor-Token");
    expect(canalPelaChave).not.toHaveBeenCalled();
  });

  it.each([
    ["404", async () => rotaConfig.GET(pedido("GET", "config"), ctx("lixo"))],
    ["401", async () => rotaMensagens.GET(pedido("GET", "messages"), ctx())],
    ["422", async () => rotaMensagens.POST(pedido("POST", "messages", { corpo: { body: "" } }), ctx())],
  ])("a resposta %s leva o header — sem ele o widget lê o erro como falha de rede", async (_n, chamar) => {
    const r = await chamar();
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    // Nada que dependa do `Origin` pode ficar em cache compartilhado.
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("vary")).toBe("Origin");
  });
});

describe("quem é recusado, e como", () => {
  it("chave malformada: 404 SEM consultar o banco", async () => {
    const r = await rotaConfig.GET(pedido("GET", "config"), ctx("../../etc/passwd"));
    expect(r.status).toBe(404);
    expect(canalPelaChave).not.toHaveBeenCalled();
  });

  it("chave inexistente ou arquivada: o MESMO 404 da malformada", async () => {
    canalPelaChave.mockResolvedValue(null);
    const inexistente = await rotaConfig.GET(pedido("GET", "config"), ctx());
    const malformada = await rotaConfig.GET(pedido("GET", "config"), ctx("lixo"));
    expect(inexistente.status).toBe(404);
    // Corpos iguais: distinguir os dois diria a quem enumera quais chaves "quase" existem.
    expect(await inexistente.json()).toEqual(await malformada.json());
  });

  it("site fora da lista do dono: 403", async () => {
    canalPelaChave.mockResolvedValue(canal(["outro-site.com"]));
    const r = await rotaConfig.GET(pedido("GET", "config"), ctx());
    expect(r.status).toBe(403);
  });

  it("ler mensagens sem token, ou com token malformado: 401", async () => {
    expect((await rotaMensagens.GET(pedido("GET", "messages"), ctx())).status).toBe(401);
    const torto = await rotaMensagens.GET(pedido("GET", "messages", { headers: { "x-visitor-token": "wv_curto" } }), ctx());
    expect(torto.status).toBe(401);
    expect(ler).not.toHaveBeenCalled();
  });

  it("token bem formado que não abre conversa nenhuma: 401, e nada é lido", async () => {
    conversaDoVisitante.mockResolvedValue(null);
    const r = await rotaMensagens.GET(pedido("GET", "messages", { headers: { "x-visitor-token": TOKEN } }), ctx());
    expect(r.status).toBe(401);
    expect(ler).not.toHaveBeenCalled();
  });

  it("POST com token MALFORMADO não abre conversa nova em silêncio", async () => {
    const r = await rotaMensagens.POST(
      pedido("POST", "messages", { headers: { "x-visitor-token": "wv_curto" }, corpo: corpoValido }),
      ctx(),
    );
    // O widget precisa saber que o que guardou não presta, para limpar e recomeçar.
    expect(r.status).toBe(401);
    expect(ingerir).not.toHaveBeenCalled();
  });

  it("client_message_id que não é UUID: 422 (é a chave de idempotência)", async () => {
    const r = await rotaMensagens.POST(pedido("POST", "messages", { corpo: { body: "oi", client_message_id: "1" } }), ctx());
    expect(r.status).toBe(422);
    expect(ingerir).not.toHaveBeenCalled();
  });

  it("campo opcional torto é DESCARTADO, não motivo de 422 — o visitante não tem como consertar", async () => {
    ingerir.mockResolvedValue({ status: "ingested", conversationId: "c", tokenNovo: TOKEN, mensagem: null });
    const r = await rotaMensagens.POST(
      pedido("POST", "messages", { corpo: { ...corpoValido, pagina: { utm: { "não-é-utm": "x" } }, visitante: 42 } }),
      ctx(),
    );
    expect(r.status).toBe(201);
    expect(ingerir.mock.calls[0]?.[1]).toMatchObject({ texto: "oi", visitante: undefined });
  });
});

describe("o que um anônimo NÃO consegue empurrar para dentro", () => {
  it("corpo gigante: 413 antes de parsear — e nada é gravado", async () => {
    const r = await rotaMensagens.POST(
      pedido("POST", "messages", { corpo: { ...corpoValido, body: "x".repeat(40_000) } }),
      ctx(),
    );
    expect(r.status).toBe(413);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(ingerir).not.toHaveBeenCalled();
  });

  it("`javascript:` na URL da página é DESCARTADO na entrada — nunca chega ao banco", async () => {
    ingerir.mockResolvedValue({ status: "ingested", conversationId: "c", tokenNovo: TOKEN, mensagem: null });
    for (const url of ["javascript:alert(1)", "data:text/html,<script>1</script>", "não é url"]) {
      const r = await rotaMensagens.POST(
        pedido("POST", "messages", { corpo: { ...corpoValido, pagina: { url, titulo: "Planos" } } }),
        ctx(),
      );
      // A mensagem do visitante NÃO se perde por causa de um campo acessório torto.
      expect(r.status).toBe(201);
      const entrada = ingerir.mock.calls.at(-1)?.[1] as { pagina?: { url?: string; titulo?: string } };
      expect(entrada.pagina?.url).toBeUndefined();
      expect(entrada.pagina?.titulo).toBe("Planos");
      expect(JSON.stringify(entrada)).not.toContain("javascript:");
    }
  });

  it("URL http(s) de verdade passa", async () => {
    ingerir.mockResolvedValue({ status: "ingested", conversationId: "c", tokenNovo: TOKEN, mensagem: null });
    await rotaMensagens.POST(
      pedido("POST", "messages", { corpo: { ...corpoValido, pagina: { url: "https://loja.exemplo.com/planos" } } }),
      ctx(),
    );
    expect((ingerir.mock.calls.at(-1)?.[1] as { pagina?: { url?: string } }).pagina?.url).toBe(
      "https://loja.exemplo.com/planos",
    );
  });
});

describe("o campo-isca", () => {
  it("preenchido: responde 201 como se tivesse dado certo e NÃO grava nada", async () => {
    const r = await rotaMensagens.POST(
      pedido("POST", "messages", { corpo: { ...corpoValido, website: "http://spam.example" } }),
      ctx(),
    );
    // Um 4xx ensinaria o robô a parar de preencher o campo.
    expect(r.status).toBe(201);
    expect(ingerir).not.toHaveBeenCalled();
    // E não gasta balde de rate limit de visitante de verdade.
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});

describe("rate limit", () => {
  it("conversa NOVA: balde por IP e por widget, nos limites declarados", async () => {
    ingerir.mockResolvedValue({ status: "ingested", conversationId: "c", tokenNovo: TOKEN, mensagem: null });
    await rotaMensagens.POST(
      pedido("POST", "messages", { headers: { "x-forwarded-for": "203.0.113.9" }, corpo: corpoValido }),
      ctx(),
    );
    const baldes = checkRateLimit.mock.calls.map((c) => [c[0], c[1], c[2]]);
    expect(baldes).toEqual([
      ["site_chat:nova:ip:203.0.113.9", LIMITES.conversaNova.porIp, LIMITES.conversaNova.janelaS],
      ["site_chat:nova:w:canal-1", LIMITES.conversaNova.porWidget, LIMITES.conversaNova.janelaS],
    ]);
  });

  it("sem IP (self-host sem proxy na frente) o balde por WIDGET continua valendo", async () => {
    ingerir.mockResolvedValue({ status: "ingested", conversationId: "c", tokenNovo: TOKEN, mensagem: null });
    await rotaMensagens.POST(pedido("POST", "messages", { corpo: corpoValido }), ctx());
    // Limite só-por-IP viraria limite nenhum justamente na instalação mais simples.
    expect(checkRateLimit.mock.calls.map((c) => c[0])).toEqual(["site_chat:nova:w:canal-1"]);
  });

  it("o balde do token NÃO leva o token para o Redis", async () => {
    conversaDoVisitante.mockResolvedValue({ id: "c", contact_id: "k" });
    await rotaMensagens.GET(pedido("GET", "messages", { headers: { "x-visitor-token": TOKEN } }), ctx());
    const chave = checkRateLimit.mock.calls[0]?.[0] as string;
    expect(chave.startsWith("site_chat:ler:")).toBe(true);
    expect(chave).not.toContain(TOKEN);
    expect(chave).not.toContain(TOKEN.slice(3, 20));
  });

  it("estourou: 429 com Retry-After, CORS, e NADA é gravado", async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false, count: 99, limit: 1, window_sec: 600 });
    const r = await rotaMensagens.POST(pedido("POST", "messages", { corpo: corpoValido }), ctx());
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("600");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(ingerir).not.toHaveBeenCalled();
  });
});

describe("o caminho feliz", () => {
  it("config: entrega a versão PÚBLICA e carimba o site que carregou", async () => {
    const r = await rotaConfig.GET(pedido("GET", "config"), ctx());
    expect(r.status).toBe(200);
    const { data } = (await r.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ titulo: CONFIG_PADRAO_DO_WIDGET.titulo, cor_do_texto: expect.any(String) });
    expect(data).not.toHaveProperty("dominios_permitidos");
    expect(registrarSinal).toHaveBeenCalledWith(expect.anything(), expect.anything(), "loja.exemplo.com");
  });

  it("config sem Origin (curl, monitor) NÃO carimba instalação", async () => {
    const semOrigem = new Request(`https://crm.exemplo.com/api/v1/site-chat/${CHAVE}/config`);
    const r = await rotaConfig.GET(semOrigem, ctx());
    expect(r.status).toBe(200);
    // Carimbar aqui diria "instalado" para um widget que ninguém colou em site nenhum.
    expect(registrarSinal).not.toHaveBeenCalled();
  });

  it("primeira mensagem: 201 com o token; a organização vem da CHAVE, nunca do corpo", async () => {
    ingerir.mockResolvedValue({ status: "ingested", conversationId: "c", tokenNovo: TOKEN, mensagem: { id: "m1" } });
    const r = await rotaMensagens.POST(
      pedido("POST", "messages", { corpo: { ...corpoValido, organization_id: "org-do-atacante" } }),
      ctx(),
    );
    expect(r.status).toBe(201);
    expect(((await r.json()) as { data: { visitor_token: string } }).data.visitor_token).toBe(TOKEN);
    const entrada = ingerir.mock.calls[0]?.[1] as { canal: { organizationId: string } };
    expect(entrada.canal.organizationId).toBe("org-a");
    expect(JSON.stringify(entrada)).not.toContain("org-do-atacante");
  });

  it("reenvio: 200 (não 201) — o widget não conta como mensagem nova", async () => {
    ingerir.mockResolvedValue({ status: "duplicate", conversationId: "c", tokenNovo: null, mensagem: null });
    const r = await rotaMensagens.POST(
      pedido("POST", "messages", { headers: { "x-visitor-token": TOKEN }, corpo: corpoValido }),
      ctx(),
    );
    expect(r.status).toBe(200);
  });
});
