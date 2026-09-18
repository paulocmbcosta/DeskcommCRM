import { readFileSync } from "node:fs";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * POR ONDE a conversa entrou, e DE QUEM ela é — o rodapé do card do inbox.
 *
 * O número mostrado é o DA EMPRESA, não o do cliente: saber por qual linha a
 * pessoa escreveu decide o tom da resposta e qual número ela vai ver
 * respondendo.
 *
 * ⚠️ A REGRA MUDOU, e a mudança é decisão do dono do produto. O rótulo do canal
 * aparecia só com MAIS DE UM número conectado ("com um só é a mesma palavra em
 * toda linha"). Hoje aparece SEMPRE: a instalação nasce com um número e ganha o
 * segundo — ou um canal de outro tipo — sem aviso, e quem atende precisa saber
 * por onde a pessoa entrou antes de abrir a conversa. A objeção antiga (ruído
 * na faixa dos selos) foi respondida mudando o LUGAR: o canal saiu dos selos e
 * foi para um rodapé próprio, ao lado do time, com a mesma forma em todo card.
 *
 * Metade dos casos segue provando quando NADA aparece: rótulo vazio é pior que
 * rótulo ausente, e o time só é afirmado quando se sabe qual é.
 */
import { ConversationListItem } from "@/components/inbox/ConversationListItem";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

const base = {
  id: "c1",
  organization_id: "org",
  contact_id: "ct1",
  channel_session_id: "s1",
  channel: "whatsapp",
  status: "open",
  last_message_at: new Date().toISOString(),
  last_message_preview: "olá",
  unread_count_for_assignee: 0,
  created_at: new Date().toISOString(),
  contacts: { id: "ct1", display_name: "Cliente", name: null, phone_number: "+595999", tags: [], is_blocked: false, is_anonymized: false },
} as unknown as ConversationWithContact;

const comCanal = (canal: { phone_number: string | null; display_name: string | null } | null) =>
  ({ ...base, channel_sessions: canal }) as ConversationWithContact;

const pintar = (
  conv: ConversationWithContact,
  props: Partial<React.ComponentProps<typeof ConversationListItem>> = {},
) =>
  render(<ConversationListItem conversation={conv} isSelected={false} onSelect={() => {}} {...props} />);

describe("o canal por onde a conversa entrou aparece SEMPRE", () => {
  it("sem pedir nada: o padrão é mostrar", () => {
    pintar(comCanal({ phone_number: "+19392301037", display_name: null }));
    expect(screen.getByText("+19392301037")).toBeInTheDocument();
  });

  it("com apelido E número: o apelido diz qual linha, os 4 dígitos desempatam", () => {
    // Dois canais chamados "Suporte" existem; o final do número é o que separa.
    pintar(comCanal({ phone_number: "+19392301037", display_name: "MP wp" }));
    expect(screen.getByText("MP wp · 1037")).toBeInTheDocument();
  });

  it("cai no NOME do canal quando ainda não há número", () => {
    // Canal recém-conectado (ou de outro tipo, sem telefone) pode não ter
    // número; mostrar nada seria pior que mostrar como ele se chama.
    pintar(comCanal({ phone_number: null, display_name: "Canal novo" }));
    expect(screen.getByText("Canal novo")).toBeInTheDocument();
  });

  it("o title diz o número INTEIRO — o rótulo abrevia", () => {
    pintar(comCanal({ phone_number: "+19392301037", display_name: "MP wp" }));
    expect(screen.getByTitle("Entrou por +19392301037")).toBeInTheDocument();
  });

  it("não confunde com o número do CLIENTE", () => {
    // O contato tem +595999; o canal tem +1939. O que aparece é o da EMPRESA —
    // trocar os dois faria o atendente ligar para si mesmo.
    pintar(comCanal({ phone_number: "+19392301037", display_name: null }));
    expect(screen.getByTitle("Entrou por +19392301037")).toBeInTheDocument();
    expect(screen.queryByTitle("Entrou por +595999")).not.toBeInTheDocument();
  });
});

describe("o time que espera pela conversa", () => {
  it("mostra o NOME do time, ao lado do canal", () => {
    pintar(comCanal({ phone_number: "+19392301037", display_name: null }), {
      nomeDoTime: "Cobrança",
      orgTemTimes: true,
    });
    expect(screen.getByText("Cobrança")).toBeInTheDocument();
    expect(screen.getByTestId("rodape-da-conversa")).toHaveTextContent("+19392301037");
  });

  it("sem time, numa org que USA times: diz 'Sem time' — é informação, não ausência", () => {
    pintar(comCanal(null), { nomeDoTime: null, orgTemTimes: true });
    expect(screen.getByText("Sem time")).toBeInTheDocument();
  });

  it("numa org que NÃO usa times, não inventa a feature em toda linha", () => {
    pintar(comCanal(null), { nomeDoTime: null, orgTemTimes: false });
    expect(screen.queryByText("Sem time")).not.toBeInTheDocument();
  });

  it("catálogo de times ainda carregando: não afirma 'Sem time' sobre conversa que pode ter", () => {
    // `undefined` é "não sei". Imprimir "Sem time" aqui seria mentira de tela
    // por alguns instantes em toda conversa que TEM time.
    pintar(comCanal(null), { nomeDoTime: undefined, orgTemTimes: true });
    expect(screen.queryByText("Sem time")).not.toBeInTheDocument();
  });
});

describe("NÃO mostra quando não há o que dizer", () => {
  it("a prop desliga o canal (é o que um contexto sem rodapé usaria)", () => {
    pintar(comCanal({ phone_number: "+19392301037", display_name: "MP wp" }), { mostrarCanal: false });
    expect(screen.queryByTitle(/Entrou por/)).not.toBeInTheDocument();
  });

  it("sem canal no payload não quebra a linha", () => {
    // Conversa em cache de antes do campo existir, ou sessão apagada.
    expect(() => pintar(comCanal(null))).not.toThrow();
    expect(screen.getByText("Cliente")).toBeInTheDocument();
  });

  it("canal sem número E sem nome não vira rótulo vazio", () => {
    pintar(comCanal({ phone_number: null, display_name: null }));
    expect(screen.getByText("Cliente")).toBeInTheDocument();
    expect(screen.queryByTitle(/Entrou por/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("rodape-da-conversa")).not.toBeInTheDocument();
  });
});

describe("o elo que some sem barulho", () => {
  it("o SELECT do listado traz a sessão — sem isso o rótulo nunca tem o que mostrar", () => {
    // O componente pode estar perfeito e o rótulo não aparecer nunca, porque o
    // dado não chega. É a mesma classe do filtro por `tag`, que o hook serializa
    // e a rota nunca lê: três arquivos, e o defeito mora no que ninguém testou.
    const fonte = readFileSync("app/api/v1/conversations/_handler.ts", "utf8");
    expect(fonte, "falta o embed da sessão no SELECT_COLS").toMatch(
      /channel_sessions:channel_session_id\s*\([^)]*phone_number/,
    );
  });

  it("a lista NÃO decide mais pelo número de canais, e entrega o nome do time", () => {
    const fonte = readFileSync("components/inbox/ConversationList.tsx", "utf8");
    // A regra antiga, se voltar, esconde o canal de toda instalação de um número só.
    expect(fonte).not.toMatch(/mostrarCanal=\{/);
    // O nome do time sai do catálogo, UMA vez por lista — nunca um hook por linha.
    expect(fonte).toContain("useTimesDoInbox");
    expect(fonte).toContain("nomeDoTime=");
  });
});
