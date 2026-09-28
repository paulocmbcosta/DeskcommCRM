/**
 * PUBLIC_PATHS decide quem atravessa o proxy sem sessão em toda a aplicação
 * (`proxy.ts`). Sem teste, uma âncora `$` trocada por prefixo, ou uma entrada
 * larga demais, some em silêncio do CI — foi exatamente o bug achado provando
 * a Task 6 (heartbeat do agente bloqueado por faltar aqui).
 */
import { describe, it, expect } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";

describe("isPublicPath", () => {
  it("libera o heartbeat do agente do host (bearer, sem cookie)", () => {
    expect(isPublicPath("/api/v1/system/agent")).toBe(true);
  });

  it("libera o tick do relógio Hobby (bearer, sem cookie)", () => {
    expect(isPublicPath("/api/v1/system/relogio/tick")).toBe(true);
    expect(isPublicPath("/api/v1/system/relogio")).toBe(false);
    expect(isPublicPath("/api/v1/system/relogio/tick/extra")).toBe(false);
  });

  it("a âncora `$` impede que um sub-path passe de carona", () => {
    expect(isPublicPath("/api/v1/system/agent/qualquer")).toBe(false);
  });

  it("não libera a rota de pedido de atualização (exige sessão do dono)", () => {
    expect(isPublicPath("/api/v1/system/update")).toBe(false);
  });

  it("não libera a rota de estado da versão (exige sessão)", () => {
    expect(isPublicPath("/api/v1/system/version")).toBe(false);
  });

  /**
   * Os documentos legais são linkados do checkbox OBRIGATÓRIO da primeira tela
   * do produto (`/onboarding/welcome`). Fora daqui, `proxy.ts` manda o visitante
   * para `/login?next=/legal/terms` — e um aceite de termos que só se lê depois
   * de ter conta é um aceite que ninguém pode conferir antes de aceitar.
   */
  it("libera os documentos legais — o aceite acontece antes de existir conta", () => {
    expect(isPublicPath("/legal/terms")).toBe(true);
    expect(isPublicPath("/legal/privacy")).toBe(true);
  });

  /**
   * O chat do site é chamado pelo `widget.js` no site de um terceiro — sem
   * cookie por construção. Fora daqui o proxy responde 401 antes de a rota
   * existir, e o balão aparece no site do cliente sem nunca conseguir enviar.
   */
  it("libera os dois recursos do chat do site — quem chama é o site de um terceiro", () => {
    expect(isPublicPath("/api/v1/site-chat/wc_abcdefghijklmnopqrstuvwx/config")).toBe(true);
    expect(isPublicPath("/api/v1/site-chat/wc_abcdefghijklmnopqrstuvwx/messages")).toBe(true);
  });

  /**
   * O porteiro do WebSocket do ramal responde ao PROXY, que não repassa
   * `Set-Cookie`: se o `proxy.ts` renovasse a sessão aqui, o refresh token novo
   * se perderia e o reúso do velho revogaria a sessão do atendente. A rota
   * autoriza sozinha, sem renovar (`lib/auth/sessao-sem-renovar.ts`).
   */
  it("o porteiro do WebSocket do ramal passa pelo proxy sem renovar a sessão — e só ele", () => {
    expect(isPublicPath("/api/v1/telefonia/ws/autorizar")).toBe(true);
    expect(isPublicPath("/api/v1/telefonia/ws/autorizar/extra")).toBe(false);
    expect(isPublicPath("/api/v1/telefonia/ramal")).toBe(false);
    expect(isPublicPath("/api/v1/telefonia/numeros")).toBe(false);
  });

  it("e só esses dois: a administração do chat do site exige sessão", () => {
    expect(isPublicPath("/api/v1/site-chat")).toBe(false);
    expect(isPublicPath("/api/v1/site-chat/wc_abc/config/extra")).toBe(false);
    expect(isPublicPath("/api/v1/site-chat/wc_abc/qualquer-outra")).toBe(false);
    // A rota de ADMINISTRAÇÃO mora noutro prefixo e nunca pode pegar carona.
    expect(isPublicPath("/api/v1/channels/site-chat")).toBe(false);
    expect(isPublicPath("/api/v1/channels/site-chat/123")).toBe(false);
  });

  it("e só esses dois: /legal não é um portão aberto", () => {
    // Entrada larga aqui é furo de auth em toda a aplicação, não só nesta tela.
    expect(isPublicPath("/legal")).toBe(false);
    expect(isPublicPath("/legal/terms/interno")).toBe(false);
    expect(isPublicPath("/legal/qualquer-outra")).toBe(false);
  });
});
