/**
 * AS DUAS FERRAMENTAS QUE O AGENTE DE IA USA COM UM CONECTOR — os nomes e o texto
 * que o MODELO lê.
 *
 * Uma fonte para três lugares: o motor (ferramentas nativas,
 * `lib/agent-engine/agent/ferramentas-do-conector.ts`), o handler MCP que existe
 * pela paridade catálogo×handler (`lib/mcp/tools/sistema-de-gestao.ts`) e a rota
 * que serve o catálogo à tela (só as oferece a quem tem conector). O nome é
 * contrato de wire: renomear quebra `tool_ids` de agente publicado.
 */
export const FERRAMENTA_CONSULTAR_CLIENTE = "crm_consultar_cliente_erp";
export const FERRAMENTA_ENVIAR_COBRANCA = "crm_enviar_cobranca_erp";

export const FERRAMENTAS_DO_CONECTOR = [FERRAMENTA_CONSULTAR_CLIENTE, FERRAMENTA_ENVIAR_COBRANCA] as const;
/** A mesma lista como `string[]`, para quem compara com id vindo do banco (`tool_ids`). */
export const IDS_DAS_FERRAMENTAS_DO_CONECTOR: readonly string[] = FERRAMENTAS_DO_CONECTOR;

export const DESCRICAO_CONSULTAR_CLIENTE =
  "Consulta o cliente DESTA conversa no sistema de gestão da empresa: situação do acesso, plano, " +
  "conexão, se há ordem de serviço aberta e as faturas em aberto. Chame SEM argumentos primeiro. " +
  "Se a resposta pedir CPF (ou CPF e data de nascimento), peça ao cliente e chame de novo com os " +
  "dados — a data vai como AAAA-MM-DD. Nunca diga ao cliente qual dado não conferiu. Use antes de " +
  "falar de pagamento, bloqueio ou fatura, e siga a `orientacao` da resposta.";

export const DESCRICAO_ENVIAR_COBRANCA =
  "Envia ao cliente DESTA conversa a cobrança da fatura da vez — a mais atrasada; sem atrasada, a " +
  "próxima a vencer; NUNCA duas. Sai em duas mensagens: o arquivo (QR code do Pix ou PDF do boleto) " +
  "e o código para copiar. Por padrão é Pix; use forma \"boleto\" só se o cliente pedir boleto. " +
  "Chame ANTES de escrever texto no turno (a cobrança ocupa 2 dos envios do turno) e depois escreva " +
  "no máximo uma frase curta, sem repetir código nem valor. Siga a `orientacao` da resposta.";
