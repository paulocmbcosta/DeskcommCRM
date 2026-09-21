import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { getAdapter } from "@/lib/channels";
import {
  CHANNEL_CAPABILITIES,
  CHANNEL_PROVIDER_SITE_WIDGET,
  PROVIDERS_DE_MENSAGEM,
  PROVIDERS_QUE_FALAM_PRIMEIRO,
  canalFalaPrimeiro,
  capabilitiesOf,
  meioDoCanal,
  transportaMensagem,
} from "@/lib/channels/capabilities";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import { fonteDeTemplates } from "@/lib/channels/templates-fonte";

import { nomeiaProvider } from "../../scripts/lint-channels.pattern";

/**
 * O QUARTO CANAL DE MENSAGEM — e o primeiro que não é WhatsApp.
 *
 * Espelha `canal-zernio-vocabulario.test.ts`: o vocabulário (tipo, matriz,
 * coluna de ref, adapter) e a tripla de migration nascem JUNTOS, e este arquivo
 * prende os cinco no mesmo lugar. O que é novo aqui é `outboundFirst` — a
 * primeira capability que nasce por causa de um canal que NÃO consegue algo que
 * todos os outros conseguem.
 */

describe("a matriz descreve o que o canal permite", () => {
  const caps = capabilitiesOf(CHANNEL_PROVIDER_SITE_WIDGET);

  it("nenhuma plataforma no meio: sem janela, sem modelo, sem ban, sem custo", () => {
    expect(caps).toMatchObject({
      freeformOutsideWindow: true,
      requiresTemplates: false,
      canManageTemplates: false,
      banRisk: false,
      minIntervalMs: null,
      costPerMessage: false,
      groups: "none",
    });
    expect(fonteDeTemplates(CHANNEL_PROVIDER_SITE_WIDGET)).toBeNull();
  });

  it("é canal de MENSAGEM — entra no inbox, nos seletores de agente e no vigia", () => {
    expect(transportaMensagem(CHANNEL_PROVIDER_SITE_WIDGET)).toBe(true);
    expect(PROVIDERS_DE_MENSAGEM).toContain(CHANNEL_PROVIDER_SITE_WIDGET);
  });

  it("mas NÃO fala primeiro — e é o único", () => {
    expect(caps.outboundFirst).toBe(false);
    expect(canalFalaPrimeiro(CHANNEL_PROVIDER_SITE_WIDGET)).toBe(false);
    // A lista é DERIVADA da matriz: se alguém a escrever à mão, este caso é o
    // que acusa a divergência.
    expect([...PROVIDERS_QUE_FALAM_PRIMEIRO].sort()).toEqual(
      PROVIDERS_DE_MENSAGEM.filter((p) => CHANNEL_CAPABILITIES[p].outboundFirst).sort(),
    );
    expect(PROVIDERS_QUE_FALAM_PRIMEIRO).not.toContain(CHANNEL_PROVIDER_SITE_WIDGET);
    expect(PROVIDERS_QUE_FALAM_PRIMEIRO.length).toBe(PROVIDERS_DE_MENSAGEM.length - 1);
  });

  it("falha fechado: provider desconhecido e voz não falam primeiro", () => {
    for (const p of ["telegram", "wacalls", "", null, undefined]) expect(canalFalaPrimeiro(p)).toBe(false);
  });

  it("o MEIO é `site_chat` — o vocabulário que a feature pode usar", () => {
    expect(meioDoCanal(CHANNEL_PROVIDER_SITE_WIDGET)).toBe("site_chat");
    // Três transportes, um meio: é por isso que a tela nunca precisou do provider.
    for (const p of PROVIDERS_QUE_FALAM_PRIMEIRO) expect(meioDoCanal(p)).toBe("whatsapp");
    expect(meioDoCanal("wacalls")).toBeNull();
    expect(meioDoCanal("telegram")).toBeNull();
  });
});

describe("quem INICIA conversa não escolhe este canal", () => {
  it("a automação filtra pelos que falam primeiro, não por todo canal de mensagem", () => {
    const fonte = readFileSync("lib/automation/start-conversation.ts", "utf8");
    expect(fonte).toContain("PROVIDERS_QUE_FALAM_PRIMEIRO");
    expect(fonte).not.toMatch(/\.in\("provider", \[\.\.\.PROVIDERS_DE_MENSAGEM\]\)/);
  });

  it("o funil único de abrir conversa recusa pela CAPACIDADE", () => {
    const fonte = readFileSync("lib/messaging/open-shared-contact-conversation.ts", "utf8");
    expect(fonte).toMatch(/if \(!canalFalaPrimeiro\(/);
    expect(fonte).toContain("CANAL_NAO_FALA_PRIMEIRO");
  });

  it("as duas rotas traduzem a recusa em 422, não em 500", () => {
    for (const rota of [
      "app/api/v1/conversations/iniciar/route.ts",
      "app/api/v1/conversations/open-with-contact/route.ts",
    ]) {
      const fonte = readFileSync(rota, "utf8");
      expect(fonte).toMatch(/msg === CANAL_NAO_FALA_PRIMEIRO[\s\S]{0,400}422/);
    }
  });
});

describe("o ref da sessão e o adapter", () => {
  it("resolveSessionRef devolve a chave pública, e a coluna entra no SELECT do envio", () => {
    expect(resolveSessionRef({ provider: "site_widget", site_widget_key: "wc_abc" })).toBe("wc_abc");
    expect(CHANNEL_SESSION_REF_COLUMNS.split(",").map((c) => c.trim())).toContain("site_widget_key");
  });

  const adapter = getAdapter(CHANNEL_PROVIDER_SITE_WIDGET);

  it("contato SEM telefone tem destinatário — senão o handler grava `missing_phone_number`", () => {
    // O portão do envio é `!chatId`. `null` aqui = toda resposta do atendente a
    // um visitante do site nasceria `failed`.
    expect(
      adapter.resolveRecipient({ isGroup: false, groupChatId: null, phoneNumber: null, waIdentity: null }),
    ).toEqual(expect.any(String));
    expect(
      adapter.resolveRecipient({ isGroup: true, groupChatId: "x@g.us", phoneNumber: null, waIdentity: null }),
    ).toBeNull();
  });

  it("enviar não fala com ninguém de fora, devolve id próprio e RESPEITA a revalidação de fronteira", async () => {
    const fetchEspiao = vi.spyOn(globalThis, "fetch");
    const beforeSend = vi.fn(async () => undefined);
    const r = await adapter.send({
      organizationId: "org",
      sessionRef: "wc_abc",
      to: "x",
      kind: "text",
      body: "olá",
      beforeSend,
    });
    expect(r.externalId).toMatch(/^site:[0-9a-f-]{36}$/);
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(fetchEspiao).not.toHaveBeenCalled();
    fetchEspiao.mockRestore();
  });

  it("fronteira que veta IMPEDE a entrega (atendimento encerrado no meio do turno)", async () => {
    await expect(
      adapter.send({
        organizationId: "org",
        sessionRef: "wc_abc",
        to: "x",
        kind: "text",
        body: "olá",
        beforeSend: async () => {
          throw new Error("service_boundary_changed");
        },
      }),
    ).rejects.toThrow("service_boundary_changed");
  });

  it("cartão de contato LANÇA em vez de gravar `sent` numa bolha vazia", async () => {
    await expect(
      adapter.send({ organizationId: "org", sessionRef: "wc_abc", to: "x", kind: "contact" }),
    ).rejects.toThrow(/contact_not_supported/);
  });

  it("sempre configurado: o transporte é o banco que já está respondendo", () => {
    expect(adapter.isConfigured()).toBe(true);
  });
});

describe("a catraca conhece o provider novo — e só o provider", () => {
  it("o identificador do transporte é barrado fora de lib/channels/", () => {
    expect(nomeiaProvider("if (s.provider === 'site_widget')")).toBe(true);
    expect(nomeiaProvider("import { SiteWidgetAdapter } from 'x'")).toBe(true);
  });

  it("o MEIO passa: a feature precisa poder dizer `site_chat`", () => {
    expect(nomeiaProvider('conversation.channel === "site_chat"')).toBe(false);
    expect(nomeiaProvider("app/api/v1/site-chat/[chave]/messages")).toBe(false);
  });

  it("o nome do provider não é palavra que um cliente diga — o guardrail de vocabulário interno deriva desta lista", () => {
    // `lib/agent-engine/guardrails/vazamento-interno.ts` barra todo nome de
    // provider na fala do agente. Um nome em linguagem natural ("webchat")
    // barraria resposta legítima num canal que É um chat de site.
    expect(CHANNEL_PROVIDER_SITE_WIDGET).toMatch(/_/);
  });
});

describe("banco e TypeScript falam o mesmo vocabulário", () => {
  const baseline = readFileSync("supabase/baseline.sql", "utf8");

  it("os dois CHECKs de provider conhecem o canal novo, no bloco ÚNICO deles", () => {
    expect(baseline).toMatch(/channel_sessions_provider_check[\s\S]{0,500}'site_widget'/);
    expect(baseline).toMatch(/provider = 'site_widget'\s+and site_widget_key\s+is not null/);
  });

  it("a coluna de ref nasce antes do CHECK que a referencia", () => {
    const col = baseline.indexOf("add column if not exists site_widget_key");
    const check = baseline.indexOf("provider = 'site_widget'");
    expect(col).toBeGreaterThan(-1);
    expect(col).toBeLessThan(check);
  });

  it("a chave é única entre TODAS as linhas — sem recorte de arquivadas", () => {
    const indice = baseline.match(
      /create unique index if not exists channel_sessions_site_widget_key_unique[\s\S]*?;/,
    )?.[0];
    expect(indice).toBeDefined();
    // Os índices da 0165 recortam `archived_at is null`. Aqui NÃO pode: chave
    // arquivada que renascesse faria o snippet esquecido de um cliente abrir
    // conversa na organização de outro.
    expect(indice).not.toContain("archived_at");
  });

  it("`conversations.channel` aceita o meio novo, recriado (clone já tem a versão antiga)", () => {
    expect(baseline).toContain("drop constraint if exists conversations_channel_check");
    expect(baseline).toMatch(/add constraint conversations_channel_check[\s\S]{0,120}'whatsapp'[\s\S]{0,40}'site_chat'/);
  });

  it("a migration versionada e a linha do MANIFEST existem junto do apêndice", () => {
    const mig = readFileSync("supabase/migrations/20260920150000_0272_canal_chat_do_site.sql", "utf8");
    for (const termo of ["site_widget_key", "site_widget_config", "site_widget_seen_at", "'site_chat'"]) {
      expect(mig).toContain(termo);
      expect(baseline).toContain(termo);
    }
    expect(readFileSync("supabase/migrations/MANIFEST.md", "utf8")).toContain("0272_canal_chat_do_site");
  });
});

describe("o widget que roda no site de terceiros", () => {
  const widget = readFileSync("public/site-chat/widget.js", "utf8");
  const codigo = widget.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");

  it("nenhum dado de fora vira marcação: sem innerHTML, outerHTML, insertAdjacentHTML ou document.write", () => {
    // O que o atendente escreve e o que a configuração traz são DADOS. Um
    // `innerHTML` aqui é XSS no site do cliente, servido pelo domínio dele.
    expect(codigo).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  });

  it("o token do visitante vai em HEADER, nunca na URL", () => {
    expect(codigo).toContain('headers["X-Visitor-Token"] = token');
    expect(codigo).not.toMatch(/[?&]token=/);
  });

  it("não manda cookie do site hospedeiro nem o nosso", () => {
    expect(codigo).toContain('credentials: "omit"');
  });

  it("só abre link http(s) — `javascript:` nunca vira href", () => {
    expect(codigo).toMatch(/https\?:\\\/\\\//);
    expect(codigo).not.toContain("javascript:");
  });

  it("white-label: nenhuma marca de produto mora no arquivo que vai para o site do cliente", () => {
    expect(widget.toLowerCase()).not.toContain("deskcomm");
  });

  it("a forma da chave que o widget aceita é a MESMA que o servidor gera", async () => {
    const { gerarChaveDoWidget } = await import("@/lib/channels/chat-do-site/identidade");
    const forma = widget.match(/if \(!\/(\^wc_.*?\$)\/\.test\(chave\)\)/)?.[1];
    expect(forma).toBeDefined();
    expect(new RegExp(forma as string).test(gerarChaveDoWidget())).toBe(true);
  });

  it("o snippet aponta para onde o arquivo realmente está", async () => {
    const { CAMINHO_DO_SCRIPT, snippetDoWidget } = await import("@/lib/channels/chat-do-site/snippet");
    expect(() => readFileSync(`public${CAMINHO_DO_SCRIPT}`, "utf8")).not.toThrow();
    const s = snippetDoWidget("https://crm.exemplo.com", "wc_abcdefghijklmnopqrstuvwx");
    expect(s).toBe(
      '<script async src="https://crm.exemplo.com/site-chat/widget.js" data-widget-key="wc_abcdefghijklmnopqrstuvwx"></script>',
    );
  });
});
