/**
 * Schemas Zod do EPIC-03 Inbox + Messaging.
 *
 * Cobre boundary de validação das rotas /api/v1/conversations e
 * /api/v1/messages. Validações compartilhadas entre rota REST e webhooks
 * (quando o payload entra na pipeline pós-verificação HMAC).
 */
import { z } from "zod";
import { COMANDOS_DO_BANCO, type ComandoDoBanco } from "@/lib/inbox/comando-da-conversa";
import { PISO_DA_BUSCA, buscaValeConsulta } from "@/lib/inbox/termo-de-busca";

/**
 * O que a API aceita ESCREVER. Cinco valores, e a ausência de `pending`/`resolved`
 * é deliberada: quem escreve esses dois é o MOTOR (`performHumanHandoff` grava
 * `pending` ao escalar), e deixar um cliente REST gravá-los seria deixá-lo fingir
 * uma escalação que nunca aconteceu.
 */
export const conversationStatusSchema = z.enum([
  "open",
  "claimed",
  "ai_handling",
  "closed",
  "archived",
]);

/**
 * O que a API aceita FILTRAR. Sete — o vocabulário inteiro do CHECK do banco.
 *
 * Ler e escrever são perguntas diferentes, e tratá-las como uma só deixava
 * `pending` — o estado da conversa que o automático escalou — inalcançável por
 * qualquer filtro da API. Não havia como pedir "as conversas que a IA passou para
 * uma pessoa e ninguém pegou", que é a pergunta mais urgente do inbox.
 */
export const conversationStatusFiltroSchema = z.enum([
  "open",
  "pending",
  "resolved",
  "claimed",
  "ai_handling",
  "closed",
  "archived",
]);

export const messageDirectionSchema = z.enum(["inbound", "outbound"]);

export const messageTypeSchema = z.enum([
  "text",
  "image",
  "audio",
  "document",
  "sticker",
  "video",
  "location",
  "contact",
  // Envio de template aprovado (canal oficial, fora da janela de 24h). Não é
  // "texto com outro nome": o tipo é o que carrega custo, conformidade de janela e
  // o que o contato de fato viu (cabeçalho, rodapé, botões).
  "template",
]);

export const messageStatusSchema = z.enum([
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "failed",
]);

/**
 * O CONTEÚDO de uma mensagem, sem o destino.
 *
 * Separado do destino porque há dois destinos possíveis e um conteúdo só:
 * `conversation_id` (responder numa conversa que existe) e o par
 * contato/telefone (falar primeiro, em `iniciarConversaSchema`). Declarar os
 * campos duas vezes faria a segunda cópia divergir no primeiro tipo novo — e
 * `template_values` já mostrou como isso custa.
 *
 * `.omit()` não serve para derivar um do outro: o Zod 4 recusa em RUNTIME
 * ("cannot be used on object schemas containing refinements") um `.omit()`
 * sobre schema com `.refine()`, e o TypeScript aceita — o erro só aparece
 * quando o módulo é importado. Compartilhar a forma, e não recortá-la, é o que
 * funciona nos dois níveis.
 */
const camposDaMensagem = {
  type: messageTypeSchema.default("text"),
  body: z.string().min(1).max(4096).optional(),
  media_url: z.string().url().optional(),
  media_storage_path: z.string().min(1).max(500).optional(),
  media_mime: z.string().optional(),
  media_size_bytes: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Só em `type: "template"`. Nome exato aprovado na Meta. */
  template_name: z.string().min(1).max(512).optional(),
  /** Só em `type: "template"`. `pt_BR` e `pt` são templates DISTINTOS. */
  template_language: z.string().min(2).max(16).optional(),
  /**
   * Só em `type: "template"`. Valor por slot, chaveado por `slotKey`
   * (`lib/channels/meta/build-components.ts`) — a MESMA função que o formulário
   * da tela usa. Chave montada de outro jeito é o mismatch voltando.
   */
  template_values: z.record(z.string(), z.string()).optional(),
  /**
   * A mensagem que esta responde — o id da NOSSA linha, não o do provider.
   *
   * Quem envia conhece o que está na tela, e na tela está o nosso id. A
   * tradução para o id que a plataforma entende (`wamid`) é feita no handler,
   * lendo a linha apontada: pedir o `wamid` aqui obrigaria a tela a conhecer
   * o vocabulário do canal, que é justamente o que o seam existe para evitar.
   */
  reply_to_message_id: z.string().uuid().optional(),
};

/**
 * A regra do conteúdo mínimo: uma mensagem precisa DIZER alguma coisa.
 *
 * Vive à parte porque vale para os dois destinos, e uma cópia por schema
 * deixaria de valer num deles no dia em que um tipo novo aparecesse.
 */
function temConteudo(d: {
  type?: string;
  body?: string;
  media_url?: string;
  media_storage_path?: string;
  metadata?: Record<string, unknown>;
}): boolean {
  if (d.type === "contact") {
    const id = d.metadata?.shared_contact_id;
    if (typeof id === "string" && id.length > 0) return true;
    const sc = d.metadata?.shared_contact;
    if (sc && typeof sc === "object" && !Array.isArray(sc)) {
      const phone = (sc as Record<string, unknown>).phone_number;
      return typeof phone === "string" && phone.trim().length >= 8;
    }
    return false;
  }
  return !!d.body || !!d.media_url || !!d.media_storage_path;
}

const SEM_CONTEUDO = {
  message:
    "body, media_url, media_storage_path, metadata.shared_contact_id or metadata.shared_contact.phone_number required",
  path: ["body"],
};

export const sendMessageSchema = z
  .object({ conversation_id: z.string().uuid(), ...camposDaMensagem })
  .refine(temConteudo, SEM_CONTEUDO);

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/**
 * A mesma mensagem, sem destino — para quem ainda vai abrir a conversa.
 *
 * Mesmos campos e MESMA regra de conteúdo: um corpo recusado ao responder é
 * recusado ao iniciar, pelo mesmo motivo e com a mesma frase.
 */
export const mensagemDeAberturaSchema = z
  .object(camposDaMensagem)
  .refine(temConteudo, SEM_CONTEUDO);

export const claimConversationSchema = z.object({
  expected_assignee: z.string().uuid().nullable().optional(),
});

export type ClaimConversationInput = z.infer<typeof claimConversationSchema>;

/** G3-01: transferência imediata (decisão G1-06d) — reatribui com motivo opcional. */
export const transferConversationSchema = z.object({
  to_user_id: z.string().uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export type TransferConversationInput = z.infer<typeof transferConversationSchema>;

/**
 * Transferir a conversa para um TIME (migration 0263) — ou tirá-la de todos
 * eles, que é o que `null` significa e por isso ele é valor legítimo, não
 * ausência.
 *
 * `.strict()` de propósito: um `organization_id` no corpo é RECUSADO com 422 em
 * vez de ignorado em silêncio. A org sai de `auth.org.orgId` e de nenhum outro
 * lugar; recusar é a diferença entre "não te obedeci" e "não te ouvi", e só a
 * primeira o cliente consegue depurar. Mesma decisão de
 * `timeDeAtendimentoSchema`, na tela de configuração dos times.
 */
export const conversationTeamSchema = z
  .object({ team_id: z.string().uuid().nullable() })
  .strict();

export type ConversationTeamInput = z.infer<typeof conversationTeamSchema>;

export const updateConversationStatusSchema = z.object({
  status: conversationStatusSchema,
});

export type UpdateConversationStatusInput = z.infer<typeof updateConversationStatusSchema>;

/**
 * G3-05: normalização reutilizável de tag (mesmo shape de contacts.tags /
 * crm_leads.tags — text[]). trim + lowercase; 1..40 chars por tag.
 */
export const conversationTagSchema = z.string().trim().toLowerCase().min(1).max(40);

/** ≤20 tags, deduplicadas após normalização. */
export const conversationTagsSchema = z
  .array(conversationTagSchema)
  .max(20)
  .transform((tags) => Array.from(new Set(tags)));

export type ConversationTags = z.infer<typeof conversationTagsSchema>;

/** G3-05: PATCH /conversations/[id] aceita status e/ou tags (ao menos um). */
export const patchConversationSchema = z
  .object({
    status: conversationStatusSchema.optional(),
    expected_revision: z.number().int().positive().optional(),
    tags: conversationTagsSchema.optional(),
  })
  .refine((d) => d.status !== undefined || d.tags !== undefined, {
    message: "Informe status ou tags.",
  });

export type PatchConversationInput = z.infer<typeof patchConversationSchema>;

/** POST /conversations/open-with-contact — abrir inbox a partir de cartão de contato. */
export const openConversationWithContactSchema = z
  .object({
    channel_session_id: z.string().uuid().optional(),
    contact_id: z.string().uuid().optional(),
    phone_number: z.string().min(8).max(32).optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .refine((d) => !!d.contact_id || !!d.phone_number?.trim(), {
    message: "Informe contact_id ou phone_number.",
  });

export type OpenConversationWithContactInput = z.infer<typeof openConversationWithContactSchema>;

/**
 * POST /conversations/iniciar — falar primeiro com quem nunca escreveu.
 *
 * Reusa `sendMessageSchema` para a mensagem, sem o `conversation_id`: ela ainda
 * não existe, e é justamente isso que esta rota resolve. Repetir os campos aqui
 * faria a segunda declaração divergir da primeira no primeiro tipo novo — que é
 * o defeito que `template_values` já custou uma vez.
 *
 * `channel_session_id` é OBRIGATÓRIO aqui, ao contrário de `open-with-contact`.
 * A diferença é de propósito: ali a conexão vem do cartão que originou o
 * contato, e há uma resposta certa; aqui quem fala primeiro ESCOLHE por qual
 * número o cliente vai ver a mensagem chegar. Deixar o sistema escolher
 * (`sessaoProntaParaEnvio` pega "qualquer uma viva") faria a apresentação sair
 * por um número desconhecido — e o cliente não tem como saber quem é.
 */
export const iniciarConversaSchema = z
  .object({
    channel_session_id: z.string().uuid(),
    contact_id: z.string().uuid().optional(),
    phone_number: z.string().min(8).max(32).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    /**
     * O time da conversa (migration 0284). Opcional NO SCHEMA porque a
     * obrigatoriedade depende do estado da organização — sem time cadastrado
     * não há o que escolher. Quem decide é a rota, e depois o banco
     * (`fn_conversation_iniciar_no_time`).
     */
    team_id: z.string().uuid().nullable().optional(),
    mensagem: mensagemDeAberturaSchema,
  })
  .refine((d) => !!d.contact_id || !!d.phone_number?.trim(), {
    message: "Informe contact_id ou phone_number.",
    path: ["contact_id"],
  });

export type IniciarConversaRequest = z.infer<typeof iniciarConversaSchema>;

/**
 * Estados TERMINAIS: atendimento encerrado; nova entrada válida pode reabrir.
 *
 * Vive aqui, e não espalhado em cada `.not(...)`, porque "acabou" é uma decisão
 * de produto — se um dia `resolved` deixar de ser legado e passar a valer, o
 * lugar de dizer isso é um só.
 */
export const CONVERSATION_TERMINAL_STATUSES = ["closed", "archived"] as const;

/**
 * OS STATUS EM QUE UMA CONVERSA SEM DONO ESTÁ ESPERANDO UMA PESSOA.
 *
 * Existe pela MESMA razão do irmão acima — "está na fila" é decisão de produto e
 * precisa de um lugar só — e nasce de uma divergência medida: a definição estava
 * copiada em CINCO sítios e eles não concordavam entre si.
 *
 *   `supabase/baseline.sql` (trg_conversation_routing_requested)  open+pending
 *   `lib/routing/queue.ts` getQueuePosition  (o nº que o CLIENTE ouve)  open+pending
 *   `lib/routing/queue.ts` getQueuePositions (o nº que a TELA mostra)   open
 *   `lib/routing/queue.ts` getQueueStatus    (o painel do gerente)      open
 *   `app/api/v1/conversations/counts`        (o badge da aba)           open
 *   `components/inbox/InboxLayout` tabToFilter (a aba Fila)             open
 *
 * Duas consequências, as duas do produto e não de estilo:
 *
 *   1. A conversa que o automático ESCALOU fica em `status='pending'`
 *      (`performHumanHandoff`), então ela sumia da aba Fila, do badge e do painel
 *      do gerente — exatamente a conversa que mais precisa de uma pessoa era a
 *      única invisível. O trigger de roteamento, esse, sempre a enfileirou: é por
 *      isso que o rodízio a atribuía enquanto a tela jurava que ela não existia.
 *   2. Duas funções VIZINHAS no mesmo arquivo davam números diferentes: o "você é
 *      o 5º da fila" que o cliente recebe pelo WhatsApp contava `pending`, e o
 *      "3º" que o atendente lê na tela não. A promessa feita ao cliente e o que a
 *      equipe via eram calculados por réguas diferentes.
 *
 * `claimed` não entra (tem dono), `ai_handling` não entra (o automático está
 * cuidando — é a aba IA), terminais não entram.
 */
export const CONVERSATION_QUEUE_STATUSES = ["open", "pending"] as const;

/**
 * A FILA POR TIME — a MESMA régua para a lista e para o contador do badge.
 *
 * Três formas, e as três são necessárias:
 *
 *   `none`   a fila geral: as conversas SEM time. Sem este valor não haveria
 *            como pedi-la — ausência do parâmetro significa "não filtre", que é
 *            outra pergunta.
 *   `mine`   os times de quem está olhando, MAIS as sem time.
 *   `<uuid>` um time específico.
 *
 * ⚠️ É FILTRO, não barreira. Quem enxerga o quê continua sendo a RLS de
 * `conversations` e o `visibility_mode` da organização; chamar isto de restrição
 * de segurança seria afirmar uma proteção que não existe.
 *
 * Valor fora dessas três formas é RECUSADO, e não ignorado — a mesma decisão de
 * `status` e `comando`, pela mesma razão (lista menor sem explicação parece
 * resposta). E aqui há um segundo motivo, mecânico: um `team_id` que não é uuid
 * chegaria ao Postgres como `22P02` e viraria 500 — erro de sistema para o que
 * é, na verdade, uma URL inválida.
 *
 * Mora FORA do objeto porque a rota de contagem (`/conversations/counts`) não
 * usa este schema inteiro e precisa da mesma régua: sem ela, o badge aceitaria
 * um valor que a lista recusa.
 */
export const filtroDeTimeSchema = z
  .string()
  .transform((v, ctx) => {
    const valor = v.trim();
    // Vazio é "não filtre": um `?team_id=` sem valor sai de um `<select>` que
    // voltou para "todas as filas", e recusá-lo devolveria 422 para um gesto que
    // o usuário fez na tela.
    if (valor === "") return undefined;
    if (valor === "none" || valor === "mine") return valor;
    if (z.string().uuid().safeParse(valor).success) return valor;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `team_id inválido: ${valor}` });
    return z.NEVER;
  })
  // `.optional()` DEPOIS do transform, e isto não é estilo: antes dele a chave
  // vira OBRIGATÓRIA no tipo inferido (o transform é quem passa a produzir o
  // `undefined`), e todo chamador do handler — inclusive as tools MCP, que moram
  // fora deste diretório — passaria a ter de escrever `team_id: undefined` à
  // mão. Medido: o typecheck reprovou `lib/mcp/tools/conversations.ts` assim.
  .optional();

export const listConversationsQuerySchema = z.object({
  /**
   * Um status, ou vários separados por vírgula (`?status=open,pending`).
   *
   * ADITIVO: `?status=open` continua valendo e continua devolvendo o mesmo — a
   * saída é sempre normalizada para lista, e uma lista de um elemento produz o
   * mesmo SQL que a igualdade produzia. A forma plural existe porque a aba Fila
   * precisa de DOIS estados (ver `CONVERSATION_QUEUE_STATUSES`) e, sem ela, a
   * única saída seria a tela filtrar em memória o que a página já truncou.
   */
  status: z
    .union([conversationStatusFiltroSchema, z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const itens = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const validos: Array<z.infer<typeof conversationStatusFiltroSchema>> = [];
      for (const item of itens) {
        const r = conversationStatusFiltroSchema.safeParse(item);
        if (!r.success) {
          // Recusa em vez de ignorar: filtro com valor desconhecido devolveria
          // uma lista MENOR sem nada dizendo por quê — e uma lista curta parece
          // resposta, não erro.
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `status inválido: ${item}`,
          });
          return z.NEVER;
        }
        validos.push(r.data);
      }
      return validos.length > 0 ? validos : undefined;
    }),
  /**
   * QUEM MANDA na conversa — um valor, ou vários separados por vírgula.
   *
   * É o filtro que as abas passaram a usar no lugar de `status`. A diferença não
   * é de forma, é de pergunta: `status` é ciclo de vida ("aberta? fechada?"),
   * `comando` é quem responde a próxima mensagem — e o motor de IA nunca lê
   * `status`. Enquanto as abas perguntavam pelo status, a Fila listava como
   * "aguardando atendente" as conversas que o robô estava atendendo.
   *
   * O valor é calculado pelo banco (`comando_da_conversa`, migration 0203), e é
   * por isso que ele pode ir no `WHERE` sem quebrar o cursor de paginação.
   */
  comando: z
    .union([z.enum(COMANDOS_DO_BANCO), z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const itens = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (itens.length === 0) {
        // AQUI ELE DIVERGE DO `status`, DE PROPÓSITO. Lá, lista vazia vira
        // `undefined` — "sem filtro". Aqui isso seria a pior saída possível: a
        // aba pediria um conjunto vazio e receberia TUDO, ou seja, a tela
        // afirmaria que todas as conversas estão no estado que ela nomeia.
        // Melhor um 422 barulhento que uma lista plausível e errada.
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "comando vazio" });
        return z.NEVER;
      }
      const validos: ComandoDoBanco[] = [];
      for (const item of itens) {
        const r = z.enum(COMANDOS_DO_BANCO).safeParse(item);
        if (!r.success) {
          // Mesma razão do `status`: recusar, não ignorar. Uma lista menor sem
          // explicação parece resposta.
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `comando inválido: ${item}`,
          });
          return z.NEVER;
        }
        validos.push(r.data);
      }
      return validos;
    }),
  /**
   * Esconde as conversas terminais (fechada/arquivada).
   *
   * Existe porque "Minhas" filtrava SÓ por dono e `Fechar` não solta o dono
   * (de propósito: quem atendeu é histórico que vale). Sem isto, tudo que o
   * atendente já fechou ficava na aba dele para sempre, e ela deixava de
   * significar "meu trabalho" para virar "tudo que já toquei".
   */
  exclude_finished: z.boolean().optional(),
  assigned_to: z.union([z.string().uuid(), z.literal("me"), z.literal("unassigned")]).optional(),
  channel_session_id: z.string().uuid().optional(),
  tag: conversationTagSchema.optional(),
  /**
   * A fila por TIME (migration 0263). A régua inteira — as três formas que ele
   * aceita e por que valor fora delas é recusado — mora em `filtroDeTimeSchema`,
   * no topo deste arquivo, porque a rota de contagem usa a MESMA.
   */
  team_id: filtroDeTimeSchema,
  /**
   * Só as que têm mensagem não lida para o dono.
   *
   * NASCEU FORA DO CONTRATO E POR ISSO FORA DE TODO MECANISMO. Era `onlyUnread`,
   * um predicado aplicado em memória sobre a página JÁ TRUNCADA (50 linhas): com
   * as 50 primeiras lidas, a tela dizia "Sem conversas por aqui" — e o botão
   * "Carregar mais" nem era desenhado, porque o estado vazio retornava antes dele.
   * Medido na tela: ligar o filtro não gerava requisição nenhuma.
   *
   * Estando aqui, `tests/unit/rota-le-todo-filtro-do-schema.test.ts` passa a
   * cobrá-lo sozinho — a cerca deriva as chaves deste schema.
   */
  unread: z.coerce.boolean().optional(),
  /**
   * Só as que estão NA FILA DO TIME: foram para um setor, ninguém pegou e a IA
   * saiu do comando. A régua é `estaNaFilaDoTime` (`lib/inbox/espera.ts`), com o
   * espelho do banco em `app/api/v1/conversations/_na-fila.ts`.
   *
   * Aceita `true`/`false` literais — e não `z.coerce.boolean()`, que leria a
   * string `"false"` como verdadeira.
   */
  na_fila: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true" || undefined)
    // `.optional()` por ÚLTIMO: antes do transform a chave ficaria obrigatória na
    // SAÍDA, e todo chamador do handler (as tools MCP) teria de escrevê-la à mão.
    .optional(),
  /**
   * A ORDEM da lista. `espera` = quem espera resposta há mais tempo primeiro
   * (`espera_desde` asc, migration 0279), e quem não espera vai para o fim.
   * Ausente = a ordem da aba (atividade recente; na Fila, tempo de espera).
   */
  ordem: z.enum(["espera"]).optional(),
  /** Só as de cliente insatisfeito ou crítico (sentimento, migration 0280). Mesma forma de `na_fila`. */
  insatisfeitos: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true" || undefined)
    .optional(),
  /**
   * O termo de busca. A régua inteira vive em `lib/inbox/termo-de-busca.ts`, e a
   * tela lê a MESMA — repetir aqui faria os dois divergirem, e a divergência
   * apareceria como erro na cara de quem digita (a rota recusa e o hook mostra).
   *
   * `buscaValeConsulta` mede o termo DEPOIS de normalizado, e não o cru: um termo
   * feito só de pontuação passa por qualquer piso de caracteres e vira string
   * vazia na normalização — e vazio no `ilike` casa TUDO.
   */
  search: z
    .string()
    .trim()
    .refine(buscaValeConsulta, {
      message: `A busca precisa de pelo menos ${PISO_DA_BUSCA} caracteres.`,
    })
    .optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

/** "O atendimento em andamento (ou o último, se a conversa está encerrada)." */
export const ATENDIMENTO_VIGENTE = "vigente";

export const listMessagesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /**
   * RECORTA a conversa num atendimento (migration 0266): o id de um, ou
   * `vigente`. AUSENTE = a conversa inteira, que é o contrato de sempre — quem
   * já consumia esta rota (MCP, exportações) não passa a ver menos mensagens
   * por causa de uma feature de tela.
   */
  atendimento_id: z.union([z.literal(ATENDIMENTO_VIGENTE), z.string().uuid()]).optional(),
});

export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
