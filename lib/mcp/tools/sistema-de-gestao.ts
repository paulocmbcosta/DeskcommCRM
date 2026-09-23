/**
 * crm_consultar_cliente_erp / crm_enviar_cobranca_erp — pela PONTE MCP, só recusam.
 *
 * As duas existem de verdade como ferramentas NATIVAS do motor
 * (`lib/agent-engine/agent/ferramentas-do-conector.ts`): usam o cliente DAQUELA
 * conversa e enviam pela saída DAQUELE turno. Um cliente MCP externo não tem
 * conversa para amarrar, e abrir o ERP por contato a uma integração é superfície
 * que ninguém pediu. Este handler existe pela paridade catálogo×handler
 * (`lib/mcp/tools/index.ts`), e `NATIVAS_DO_MOTOR` impede a ponte de montá-lo num turno.
 */
import { z } from "zod";

import {
  DESCRICAO_CONSULTAR_CLIENTE,
  DESCRICAO_ENVIAR_COBRANCA,
  FERRAMENTA_CONSULTAR_CLIENTE,
  FERRAMENTA_ENVIAR_COBRANCA,
} from "@/lib/conectores/ferramentas-do-agente";

import type { McpToolDefinition } from "../types";

const RECUSA = {
  error:
    "Esta capacidade só funciona dentro de uma conversa atendida por um agente de IA: ela usa o cliente daquela conversa e envia pela saída dela.",
};

const consultarShape = { cpf_cnpj: z.string().optional(), data_nascimento: z.string().optional() };
const enviarShape = { forma: z.string().optional() };

export const crmConsultarClienteErp: McpToolDefinition<typeof consultarShape> = {
  name: FERRAMENTA_CONSULTAR_CLIENTE,
  description: DESCRICAO_CONSULTAR_CLIENTE,
  inputSchema: consultarShape,
  // `write`, não `read`: a ferramenta NATIVA (que é quem de fato roda — este
  // handler só recusa) cria ou promove vínculo de cadastro e insere auditoria
  // quando o telefone bate com um cadastro do ERP. Paridade com
  // `GET /api/v1/contacts/[id]/conectores/ixc`, que também é GET e GRAVA (um
  // único candidato por telefone vincula sozinho) — achado da revisão de
  // qualidade do Lote D+E: `read` aqui escapava dos dois gates que varrem por
  // `category === "write"` (escopo de funil e vacuidade da tabela).
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async () => RECUSA,
};

export const crmEnviarCobrancaErp: McpToolDefinition<typeof enviarShape> = {
  name: FERRAMENTA_ENVIAR_COBRANCA,
  description: DESCRICAO_ENVIAR_COBRANCA,
  inputSchema: enviarShape,
  category: "write",
  // Paridade com a rota do botão (`…/faturas/[id]/enviar`), que pede `agent`.
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async () => RECUSA,
};
