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
    category: "read",
    rotulo: "Consultar o cliente no sistema de gestão",
    explicacao:
      "Procura o cliente da conversa no sistema de gestão conectado e mostra ao agente a situação do acesso, o plano, a conexão e as faturas em aberto — sem CPF, endereço nem senha. Quem não é reconhecido pelo telefone precisa confirmar CPF e data de nascimento.",
    oQueToca: "Sistema de gestão conectado",
    // `seguro`, não `atencao`: a regra do catálogo é pela CATEGORIA técnica
    // (`tests/unit/catalogo-tools-leigo-friendly.test.ts` — "read" só pode
    // anunciar "seguro"), não pela sensibilidade do dado. Esta tool só lê, e
    // já sai sem CPF, endereço nem senha (ver `explicacao`).
    risco: "seguro",
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
