/**
 * Capacidades do SISTEMA DE GESTÃO conectado (fase 4 do conector IXC) — consultar
 * o cliente da conversa e enviar a cobrança dele.
 *
 * São ferramentas NATIVAS do motor (`lib/agent-engine/agent/ferramentas-do-conector.ts`):
 * a cobrança tem de sair pela cadeia de envio do turno. O item de catálogo existe
 * para a TELA — é o interruptor por agente —, e o handler MCP correspondente só
 * recusa. `GET /api/v1/mcp/tools` só as serve a quem tem conector ligado.
 *
 * ESTE ARQUIVO FALA COM O HUMANO que configura o agente. O texto do MODELO mora em
 * `lib/conectores/ferramentas-do-agente.ts`.
 */
import { declararTools } from "./tipos";

export const TOOLS_SISTEMA_DE_GESTAO = declararTools([
  {
    name: "crm_consultar_cliente_erp",
    // `write`, não `read`: quando o telefone bate com um cadastro do ERP, ela
    // cria ou promove o vínculo e insere auditoria — a MESMA gravação que
    // `GET /api/v1/contacts/[id]/conectores/ixc` faz pela tela (é GET e GRAVA).
    // `read` escondia isso dos dois gates que varrem por `category === "write"`
    // (escopo de funil e a vacuidade de `ALVO_DE_FUNIL`) — achado da revisão de
    // qualidade do Lote D+E.
    category: "write",
    rotulo: "Consultar o cliente no sistema de gestão",
    explicacao:
      "Procura o cliente da conversa no sistema de gestão conectado e mostra ao agente a situação do acesso, o plano, a conexão e as faturas em aberto — sem CPF, endereço nem senha. Quem não é reconhecido pelo telefone precisa confirmar CPF e data de nascimento. Pode vincular o contato a um cadastro do sistema quando o telefone bate com um só.",
    oQueToca: "Sistema de gestão conectado",
    // `atencao`, não `seguro`: a regra do catálogo é pela CATEGORIA técnica
    // (`tests/unit/catalogo-tools-leigo-friendly.test.ts` — "write" nunca pode
    // anunciar "seguro"), e esta tool ESCREVE (vínculo + auditoria), mesmo sem
    // expor CPF, endereço nem senha ao modelo (ver `explicacao`).
    risco: "atencao",
    pacotes: ["atender"],
  },
  {
    name: "crm_enviar_cobranca_erp",
    category: "write",
    rotulo: "Enviar a cobrança do cliente (Pix ou boleto)",
    explicacao:
      "Manda ao cliente a cobrança de UMA fatura — a mais atrasada, ou a próxima a vencer —, com o QR code do Pix ou o PDF do boleto e o código para copiar. Fatura com atraso acima do limite configurado não é enviada: a conversa vai para a cobrança.",
    oQueToca: "Mensagens ao cliente e sistema de gestão",
    risco: "critico",
    pacotes: ["atender"],
  },
]);
