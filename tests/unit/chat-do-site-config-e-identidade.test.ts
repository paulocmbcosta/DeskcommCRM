import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CONFIG_PADRAO_DO_WIDGET,
  configDoWidgetSchema,
  configPublica,
  lerConfig,
  origemPermitida,
} from "@/lib/channels/chat-do-site/config";
import {
  chaveDoWidgetTemForma,
  gerarChaveDoWidget,
  gerarTokenDoVisitante,
  threadDoVisitante,
  tokenDoVisitanteTemForma,
} from "@/lib/channels/chat-do-site/identidade";
import { razaoDeContraste } from "@/lib/branding/contraste";

describe("config do widget — tolerante na leitura, estrita na escrita", () => {
  it("o padrão é uma configuração VÁLIDA (um widget recém-criado tem que funcionar)", () => {
    expect(configDoWidgetSchema.safeParse(CONFIG_PADRAO_DO_WIDGET).success).toBe(true);
  });

  it("`lerConfig` nunca lança, qualquer que seja o lixo no jsonb", () => {
    for (const lixo of [null, undefined, 42, "texto", [], { cor_principal: 7 }, { formulario_inicial: "x" }]) {
      expect(() => lerConfig(lixo)).not.toThrow();
      expect(configDoWidgetSchema.safeParse(lerConfig(lixo)).success).toBe(true);
    }
  });

  it("UM campo inválido cai no padrão sem levar os outros junto", () => {
    const lida = lerConfig({ titulo: "Minha loja", cor_principal: "azul", posicao: "esquerda" });
    // Com um `safeParse` do objeto inteiro, a cor inválida "resetaria" o título
    // e a posição que estavam certos — o dono veria o widget zerado sem motivo.
    expect(lida).toMatchObject({
      titulo: "Minha loja",
      posicao: "esquerda",
      cor_principal: CONFIG_PADRAO_DO_WIDGET.cor_principal,
    });
  });

  it("a escrita recusa campo desconhecido, cor inválida e domínio com esquema", () => {
    const base = CONFIG_PADRAO_DO_WIDGET;
    expect(configDoWidgetSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(configDoWidgetSchema.safeParse({ ...base, cor_principal: "vermelho" }).success).toBe(false);
    expect(configDoWidgetSchema.safeParse({ ...base, dominios_permitidos: ["https://exemplo.com"] }).success).toBe(false);
    expect(configDoWidgetSchema.safeParse({ ...base, dominios_permitidos: ["exemplo.com/pagina"] }).success).toBe(false);
    expect(configDoWidgetSchema.safeParse({ ...base, dominios_permitidos: ["*.exemplo.com", "localhost"] }).success).toBe(true);
  });

  it("a cor do texto é CALCULADA e sempre legível sobre a cor escolhida", () => {
    for (const cor of ["#ffff00", "#000000", "#ffffff", "#2563eb", "#ff69b4", "#7f7f7f"]) {
      const p = configPublica({ ...CONFIG_PADRAO_DO_WIDGET, cor_principal: cor });
      // Branco sobre amarelo de marca é o defeito que isto existe para impedir.
      expect(razaoDeContraste(p.cor_do_texto, cor)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("o que vai ao widget NÃO leva a lista de sites do dono", () => {
    const p = configPublica({ ...CONFIG_PADRAO_DO_WIDGET, dominios_permitidos: ["cliente-secreto.com.br"] });
    expect(JSON.stringify(p)).not.toContain("cliente-secreto");
  });
});

describe("origemPermitida — cerca para navegador, não autenticação", () => {
  it("lista vazia = qualquer site (widget recém-criado funciona no primeiro site)", () => {
    expect(origemPermitida("https://qualquer.com", [])).toBe(true);
    expect(origemPermitida(null, [])).toBe(true);
  });

  it("com lista, pedido SEM Origin é recusado (é justamente quem não é navegador)", () => {
    expect(origemPermitida(null, ["exemplo.com"])).toBe(false);
  });

  it("`exemplo.com` cobre `www.exemplo.com`, e vice-versa", () => {
    expect(origemPermitida("https://www.exemplo.com", ["exemplo.com"])).toBe(true);
    expect(origemPermitida("https://exemplo.com", ["www.exemplo.com"])).toBe(true);
  });

  it("curinga cobre subdomínio e o domínio nu — e só eles", () => {
    expect(origemPermitida("https://loja.exemplo.com", ["*.exemplo.com"])).toBe(true);
    expect(origemPermitida("https://exemplo.com", ["*.exemplo.com"])).toBe(true);
    expect(origemPermitida("https://exemplo.com.atacante.net", ["*.exemplo.com"])).toBe(false);
    expect(origemPermitida("https://falsoexemplo.com", ["*.exemplo.com"])).toBe(false);
  });

  it("sufixo parecido não passa", () => {
    expect(origemPermitida("https://meuexemplo.com", ["exemplo.com"])).toBe(false);
    expect(origemPermitida("https://exemplo.com.br", ["exemplo.com"])).toBe(false);
    expect(origemPermitida("isto não é url", ["exemplo.com"])).toBe(false);
  });
});

describe("identidade — a chave pública e o token do visitante", () => {
  it("a chave gerada tem a forma que a rota aceita, e duas nunca coincidem", () => {
    const chaves = new Set(Array.from({ length: 200 }, gerarChaveDoWidget));
    expect(chaves.size).toBe(200);
    for (const c of chaves) expect(chaveDoWidgetTemForma(c)).toBe(true);
  });

  it("a forma recusa lixo ANTES de qualquer consulta ao banco", () => {
    for (const lixo of ["", "wc_", "wc_curta", "../../etc/passwd", "wc_" + "a".repeat(25), "wc_aaaa aaaa", null, undefined]) {
      expect(chaveDoWidgetTemForma(lixo as string)).toBe(false);
    }
  });

  it("o token tem 256 bits e forma conferível", () => {
    const t = gerarTokenDoVisitante();
    expect(tokenDoVisitanteTemForma(t)).toBe(true);
    expect(Buffer.from(t.slice(3), "base64url")).toHaveLength(32);
    expect(tokenDoVisitanteTemForma("wv_curto")).toBe(false);
    expect(tokenDoVisitanteTemForma(t + "x")).toBe(false);
  });

  it("a thread é SHA-256 determinístico do token — e não contém o token", () => {
    const t = gerarTokenDoVisitante();
    const thread = threadDoVisitante(t);
    expect(thread).toBe(`wv:${createHash("sha256").update(t).digest("hex")}`);
    expect(threadDoVisitante(t)).toBe(thread);
    expect(thread).not.toContain(t.slice(3));
  });
});
