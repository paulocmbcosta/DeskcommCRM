import { beforeEach, describe, expect, it } from "vitest";

import { lerMensagensDoVisitante } from "@/lib/channels/chat-do-site/leitura";

import { BancoEmMemoria } from "./helpers/banco-em-memoria";

/**
 * O QUE UM ANÔNIMO LÊ — a rota pública devolve conteúdo de atendimento a quem
 * apresenta um token, então o recorte é LISTA BRANCA, e cada caso abaixo é uma
 * coisa que NÃO pode sair por ali.
 *
 * É também onde `sent` vira `delivered` — o laço de retorno do canal: um tique
 * só, parado, diz ao atendente que o visitante fechou a aba.
 */
const ORG = "org-a";
const CONV = "conv-1";

let banco: BancoEmMemoria;
const admin = () => banco.cliente as never;

function msg(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    organization_id: ORG,
    conversation_id: CONV,
    direction: "outbound",
    type: "text",
    status: "sent",
    body: id,
    media_mime: null,
    media_storage_path: null,
    media_url: null,
    external_id: null,
    metadata: {},
    revoked_at: null,
    created_at: "2026-09-20T12:00:00.000Z",
    ...extra,
  };
}

beforeEach(() => {
  banco = new BancoEmMemoria();
});

const ler = (depoisDe: string | null = null) =>
  lerMensagensDoVisitante(admin(), { organizationId: ORG, conversationId: CONV, depoisDe });

describe("o recorte do que o visitante vê", () => {
  it("só a conversa DELE, só a organização dele", async () => {
    banco.semear(
      "messages",
      msg("minha", {}),
      msg("de-outra-conversa", { conversation_id: "conv-2" }),
      msg("de-outra-org", { organization_id: "org-b" }),
    );
    expect((await ler()).map((m) => m.id)).toEqual(["minha"]);
  });

  it("saída que falhou ou está na fila NÃO aparece — o CRM não a considera enviada", async () => {
    banco.semear(
      "messages",
      msg("enviada", { status: "sent" }),
      msg("na-fila", { status: "queued" }),
      msg("enviando", { status: "sending" }),
      msg("falhou", { status: "failed" }),
    );
    expect((await ler()).map((m) => m.id)).toEqual(["enviada"]);
  });

  it("mensagem de sistema, reação e apagada ficam de fora", async () => {
    banco.semear(
      "messages",
      msg("texto", {}),
      msg("sistema", { type: "system" }),
      msg("reacao", { type: "reaction" }),
      msg("apagada", { revoked_at: "2026-09-20T12:05:00.000Z" }),
    );
    expect((await ler()).map((m) => m.id)).toEqual(["texto"]);
  });

  it("a entrada do próprio visitante aparece, e carrega o client_id que ele mandou", async () => {
    banco.semear(
      "messages",
      msg("dele", { direction: "inbound", status: "delivered", external_id: "site:abc-123" }),
    );
    const [m] = await ler();
    expect(m).toMatchObject({ direction: "inbound", client_id: "abc-123" });
  });

  it("`media_url` cru NUNCA é repassado — só link assinado do NOSSO bucket", async () => {
    banco.semear(
      "messages",
      // Num canal de WhatsApp isto aponta para endpoint autenticado do provider.
      msg("com-url-crua", { type: "image", media_url: "https://provider.interno/media/1" }),
      msg("do-nosso-bucket", {
        type: "image",
        media_mime: "image/png",
        media_storage_path: "org-a/conv-1/out-1.png",
        created_at: "2026-09-20T12:00:01.000Z",
      }),
    );
    const [crua, nossa] = await ler();
    expect(crua?.media).toBeNull();
    expect(nossa?.media?.url).toContain("/assinado/org-a/conv-1/out-1.png");
    expect(JSON.stringify([crua, nossa])).not.toContain("provider.interno");
  });
});

describe("o laço de retorno: entregar é o que promove a `delivered`", () => {
  it("a saída `sent` que foi lida pelo widget vira `delivered`", async () => {
    banco.semear("messages", msg("a", {}), msg("b", { status: "delivered" }));
    await ler();
    const linhas = banco.linhas("messages");
    expect(linhas.find((l) => l.id === "a")).toMatchObject({ status: "delivered" });
    expect(linhas.find((l) => l.id === "a")?.delivered_at).toEqual(expect.any(String));
  });

  it("não promove o que o visitante NÃO recebeu (fila, falha) nem a entrada dele", async () => {
    banco.semear(
      "messages",
      msg("na-fila", { status: "queued" }),
      msg("dele", { direction: "inbound", status: "delivered" }),
    );
    await ler();
    expect(banco.linhas("messages").find((l) => l.id === "na-fila")?.status).toBe("queued");
    expect(banco.escritas).toHaveLength(0);
  });
});

describe("o cursor", () => {
  it("sem cursor devolve as MAIS RECENTES, em ordem cronológica", async () => {
    banco.semear(
      "messages",
      ...Array.from({ length: 130 }, (_, i) =>
        msg(`m${String(i).padStart(3, "0")}`, {
          created_at: new Date(Date.UTC(2026, 8, 20, 12, 0, i)).toISOString(),
        }),
      ),
    );
    const r = await ler();
    expect(r).toHaveLength(100);
    // Asc com limite faria o visitante que volta ver as cem PRIMEIRAS e nunca a
    // resposta que o trouxe de volta.
    expect(r[0]?.id).toBe("m030");
    expect(r.at(-1)?.id).toBe("m129");
  });

  it("relê uma janela ATRÁS do cursor: a resposta promovida depois não se perde", async () => {
    // A saída nasceu às 12:00:00 como `queued` (invisível). O visitante escreveu
    // às 12:00:05 e o cursor do widget passou à frente. Só então ela virou `sent`.
    banco.semear(
      "messages",
      msg("resposta-promovida-depois", { created_at: "2026-09-20T12:00:00.000Z", status: "sent" }),
      msg("do-visitante", { direction: "inbound", status: "delivered", created_at: "2026-09-20T12:00:05.000Z" }),
    );
    const r = await ler("2026-09-20T12:00:05.000Z");
    // Com `created_at > cursor` exato, a resposta do atendente sumiria para sempre.
    expect(r.map((m) => m.id)).toContain("resposta-promovida-depois");
  });

  it("cursor inválido não derruba a leitura", async () => {
    banco.semear("messages", msg("a", {}));
    expect((await ler("isto-nao-e-data")).map((m) => m.id)).toEqual(["a"]);
  });
});
