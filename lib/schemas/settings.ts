/**
 * Zod schemas for /app/settings/* server actions and routes (EPIC-10).
 *
 * - profileSchema: persisted to auth.users.raw_user_meta_data
 * - tenantSchema: persisted to organizations row + organizations.settings jsonb
 * - notificationPrefsSchema: STUB (notification_prefs table not yet migrated)
 * - pipelineConfigPatchSchema: pipeline vocabulary + settings.fields + settings.lost_reasons
 */
import { z } from "zod";

import { ehHexValido } from "@/lib/branding/rampa";
import { IDIOMAS } from "@/lib/i18n/idiomas";
import { MOEDAS_SERVIDAS } from "@/lib/money";

import { conversationTagSchema } from "./messaging";

/**
 * Os idiomas que a interface REALMENTE serve.
 *
 * `en-US` saiu: esteve na lista desde sempre e nunca teve uma linha de
 * tradução — escolhê-lo não mudava nada. Espanhol entrou quando passou a mudar.
 * A fonte é `lib/i18n/idiomas`, para a validação e o dicionário não divergirem:
 * um idioma aceito aqui e desconhecido lá cairia no padrão em silêncio.
 */
const LOCALES = IDIOMAS;

/**
 * G6-02: organizations.settings.ai_dispatch_mode (edge-contract do Vendaval).
 * 'native' (default) = o dispatcher de IA deste repo processa os eventos
 * ai_agent.dispatch_requested. 'external' = o tenant delega o dispatch ao
 * runtime externo (Vendaval); o dispatcher nativo PULA o evento sem tocá-lo.
 * `.catch("native")` normaliza chave ausente/null/inválida para o default seguro.
 */
export const AI_DISPATCH_MODES = ["native", "external"] as const;
export type AiDispatchMode = (typeof AI_DISPATCH_MODES)[number];
export const aiDispatchModeSchema = z.enum(AI_DISPATCH_MODES).catch("native");

/**
 * G3-05: vocabulário canônico de tags de conversa, persistido em
 * organizations.settings.canonical_conversation_tags (spec 13 §3.3 — org-scoped,
 * não pipeline-scoped). Schema declarativo; usado para validar o que o inbox lê
 * como sugestões.
 */
export const canonicalConversationTagsSchema = z
  .array(conversationTagSchema)
  .max(50)
  .transform((tags) => Array.from(new Set(tags)))
  .catch([]);
export type CanonicalConversationTags = z.infer<typeof canonicalConversationTagsSchema>;
export type Locale = (typeof LOCALES)[number];

/**
 * "Sigo minha empresa" — a ausência de preferência, com um valor para ela.
 *
 * Sem isto, quem abrisse o perfil por qualquer motivo (trocar o fuso, o nome)
 * sairia de lá com uma preferência de idioma que nunca escolheu: o seletor
 * mostraria o idioma em vigor e o salvar o gravaria como decisão pessoal. A
 * partir daí, trocar o idioma da empresa não alcançaria mais essa pessoa — e
 * ninguém entenderia por quê.
 */
export const SEM_PREFERENCIA_DE_IDIOMA = "auto";

export const profileSchema = z.object({
  full_name: z.string().min(1).max(120).nullable().optional(),
  locale: z.enum([...LOCALES, SEM_PREFERENCIA_DE_IDIOMA]),
  timezone: z.string().min(1).max(64),
  avatar_url: z
    .string()
    .url()
    .max(2048)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
});
export type ProfileInput = z.infer<typeof profileSchema>;

/**
 * As moedas servidas vêm de `lib/money`, pelo mesmo motivo que os idiomas vêm
 * de `lib/i18n/idiomas`: com duas listas, uma moeda aceita aqui e ausente do
 * seletor vira um valor que ninguém consegue mais escolher de volta.
 */
const MOEDAS = MOEDAS_SERVIDAS;

export const tenantSchema = z.object({
  display_name: z.string().min(1).max(120),
  legal_name: z.string().min(1).max(200),
  cnpj: z
    .string()
    .max(20)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  timezone: z.string().min(1).max(64),
  locale: z.enum(LOCALES),
  currency: z.enum(MOEDAS),
  media_retention_days: z.coerce.number().int().min(30).max(3650),
  dpo_email: z
    .string()
    .email()
    .max(200)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  privacy_policy_url: z
    .string()
    .url()
    .max(2048)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  lost_reasons_extra: z.array(z.string().min(1).max(80)).max(50).default([]),
});
export type TenantInput = z.infer<typeof tenantSchema>;

export const NOTIFICATION_CATEGORIES = [
  "lead_assigned",
  "lead_won",
  "lead_lost",
  "mention",
] as const;
export const NOTIFICATION_CHANNELS = ["email", "in_app", "push"] as const;

export const notificationPrefsSchema = z.object({
  prefs: z.array(
    z.object({
      category: z.enum(NOTIFICATION_CATEGORIES),
      channel: z.enum(NOTIFICATION_CHANNELS),
      enabled: z.boolean(),
    }),
  ),
});
export type NotificationPrefsInput = z.infer<typeof notificationPrefsSchema>;

export const customFieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/i, "Use letras, números e underscore"),
  label: z.string().min(1).max(80),
  type: z.enum([
    "text",
    "textarea",
    "number",
    "date",
    "select",
    "multiselect",
    "boolean",
    "email",
    "phone",
    "url",
  ]),
  required: z.boolean().optional(),
  options: z
    .array(z.object({ value: z.string().min(1), label: z.string().min(1) }))
    .optional(),
});
export type CustomFieldDef = z.infer<typeof customFieldSchema>;

export const pipelineConfigPatchSchema = z.object({
  vocabulary: z
    .object({
      lead: z.string().min(1).max(40).optional(),
      deal: z.string().min(1).max(40).optional(),
      won: z.string().min(1).max(40).optional(),
      lost: z.string().min(1).max(40).optional(),
    })
    .optional(),
  fields: z.array(customFieldSchema).max(50).optional(),
  lost_reasons: z.array(z.string().min(1).max(80)).max(50).optional(),
});
export type PipelineConfigPatch = z.infer<typeof pipelineConfigPatchSchema>;

/**
 * A marca da INSTALAÇÃO (`platform_branding`) — o que a server action aceita.
 *
 * `.nullable()` em cada campo, e não `.optional()`: aqui `null` é um valor com
 * significado ("apague este campo, quero o padrão do produto"), e ausência
 * significaria "não mexa". Colapsar os dois faria a tela não ter como limpar o
 * logo depois de configurá-lo.
 *
 * `accent_hex` valida com `ehHexValido` — o validador do domínio, o MESMO que
 * `lib/branding/schema.ts` usa — e a action normaliza antes de gravar. Um regex
 * novo escrito aqui divergiria do CHECK do banco (`^#[0-9a-f]{6}$`) e o operador
 * receberia um `23514` cru na tela em vez de "essa cor não é válida".
 */
export const platformBrandingSchema = z.object({
  app_name: z.string().trim().min(1).max(120).nullable(),
  logo_url: z.string().trim().url().max(2048).nullable(),
  accent_hex: z
    .string()
    .trim()
    .refine(ehHexValido, { message: "Use uma cor no formato #rrggbb" })
    .nullable(),
  show_powered_by: z.boolean(),
});
export type PlatformBrandingInput = z.infer<typeof platformBrandingSchema>;

/**
 * A marca da ORGANIZAÇÃO (`organizations.settings.branding`) — o cliente final
 * do revendedor, e o que a Server Action `updateMarcaDaOrganizacao` aceita.
 *
 * `.nullable()` pelo mesmo motivo do schema de cima: aqui `null` é um valor com
 * significado ("apague este campo, quero o que vem da instalação") e ausência
 * significaria "não mexa". Colapsar os dois deixaria o admin sem como voltar
 * atrás depois de escolher uma cor.
 *
 * SEM `logo_url`: upload é a fase seguinte (bucket, policies, limite de tamanho,
 * delete-on-replace). Um campo aqui hoje seria contrato oferecido e não
 * implementado — a precedência por campo garante que o logo da instalação
 * continua valendo enquanto isso.
 *
 * `accent_hex` valida com `ehHexValido` — o MESMO validador do domínio que
 * `lib/branding/schema.ts` usa — e a action normaliza antes de gravar. Um regex
 * novo escrito aqui divergiria da regex da função SQL (`^#[0-9a-f]{6}$`) e o
 * admin receberia um `22023` cru na tela em vez de "essa cor não é válida".
 */
export const marcaDaOrganizacaoSchema = z.object({
  app_name: z.string().trim().min(1).max(120).nullable(),
  accent_hex: z
    .string()
    .trim()
    .refine(ehHexValido, { message: "Use uma cor no formato #rrggbb" })
    .nullable(),
});
export type MarcaDaOrganizacaoInput = z.infer<typeof marcaDaOrganizacaoSchema>;

/** Prazos por organização. Leitura legada degrada; escrita usa schema estrito. */
export const agendaSettingsWriteSchema = z.strictObject({
  confirmation_delay_minutes: z.number().int().min(1).max(10080),
  unknown_protection_minutes: z.number().int().min(1).max(10080),
  /**
   * Quanto tempo um pedido não confirmado segura o horário.
   *
   * ⚠️ `.default()` e não obrigatório: este schema é `strictObject`, e torná-lo
   * exigido faria TODO PATCH já escrito (que manda só os dois campos de cima)
   * passar a falhar — o tipo de mudança que a doutrina de packaging proíbe,
   * porque quebra quem já instalou sem nenhum aviso.
   *
   * 24h é o default porque quem confere a fila uma vez por dia não pode perder
   * pedido. O mínimo é 15 minutos: abaixo disso a expiração corre com quem está
   * decidindo naquele instante.
   */
  pending_expires_after_minutes: z.number().int().min(15).max(10080).default(1440),
}).refine(v => v.unknown_protection_minutes >= v.confirmation_delay_minutes, {message:"O prazo de proteção deve ser maior que o prazo de confirmação."});
export const agendaSettingsSchema = agendaSettingsWriteSchema.catch({confirmation_delay_minutes:10,unknown_protection_minutes:1440,pending_expires_after_minutes:1440});

/**
 * `organizations.settings.crm` — regras de CRM que cada organização liga para si.
 *
 * `cliente_pela_agenda`: quem tem horário marcado vira cliente (migration 0262).
 * Nasce DESLIGADA em toda organização, e só um administrador a liga, por
 * `fn_definir_cliente_pela_agenda` (nunca por UPDATE em `organizations`).
 *
 * ⚠️ SÓ O BOOLEANO `true` LIGA — e é a mesma régua do banco, que compara
 * `settings->'crm'->'cliente_pela_agenda' = 'true'::jsonb` em
 * `fn_marcar_contato_como_cliente`. Ausente, `false`, a string `"true"` ou
 * qualquer lixo é desligado aqui E lá. Se os dois idiomas divergissem, a tela
 * mostraria o selo de uma regra que o trigger não aplica.
 *
 * `crm` também guarda `nascimento_do_card` (abaixo, lido por `nascimentoDoCard()`
 * — ESTE schema não o conhece). ⚠️ `z.object()` sem `.passthrough()` DESCARTA
 * chave desconhecida: `crmSettingsSchema.parse(crm)` devolve só
 * `{ cliente_pela_agenda }`, sem `nascimento_do_card`. NUNCA regrave `crm` a
 * partir da saída deste schema — quem grava uma regra do `crm` grava só a sua
 * própria chave (`fn_definir_cliente_pela_agenda`,
 * `app/actions/settings/definirNascimentoDoCard.ts`), nunca o objeto inteiro,
 * senão a escrita de uma regra apaga a outra.
 */
export const crmSettingsSchema = z
  .object({ cliente_pela_agenda: z.boolean().catch(false) })
  .catch({ cliente_pela_agenda: false });

/** A regra "cliente pela agenda" está ligada nesta organização? Nunca lança. */
export function clientePelaAgendaLigado(settings: unknown): boolean {
  const crm =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).crm
      : undefined;
  return crmSettingsSchema.parse(crm ?? {}).cliente_pela_agenda === true;
}

/**
 * `organizations.settings.crm.nascimento_do_card` — QUANDO o card nasce.
 *
 * `toda_conversa` (padrão de toda organização, e o comportamento de sempre): a
 * primeira mensagem de quem não tem card abre um no funil de entrada.
 * `classificador`: nenhuma mensagem abre card sozinha. A cada mensagem de um
 * contato SEM card aberto, o Jev decide se a conversa é comercial
 * (`workers/classificador-comercial.ts`), e o card nasce quando a probabilidade
 * alcança o `limiar`.
 *
 * Lixo lê como `toda_conversa`: na dúvida, o card nasce. Card a mais se
 * arquiva; card a menos é venda que some sem ninguém ver.
 */
export const MODOS_DE_NASCIMENTO_DO_CARD = ["toda_conversa", "classificador"] as const;
export type ModoDeNascimentoDoCard = (typeof MODOS_DE_NASCIMENTO_DO_CARD)[number];
/**
 * As únicas opções da tela (Tarefa 11) — a escrita só aceita estas. A leitura
 * aceita qualquer número em [0.5, 0.95] mas ARREDONDA para a opção mais
 * próxima (empate vai para a MENOR: menor limiar = mais cards = "na dúvida o
 * card nasce"). Sem o arredondamento, um limiar gravado fora da tela (SQL,
 * migration futura) deixaria o `Select` da Tarefa 11 vazio — e a escrita
 * seguinte recusaria salvar sem o admin ter tocado no campo.
 */
export const LIMIARES_DO_CLASSIFICADOR = [0.6, 0.7, 0.8, 0.9] as const;
export const NASCIMENTO_DO_CARD_PADRAO = { modo: "toda_conversa", limiar: 0.7 } as const satisfies {
  modo: ModoDeNascimentoDoCard;
  limiar: number;
};

/**
 * A opção de `LIMIARES_DO_CLASSIFICADOR` mais próxima de `v`; empate → a menor.
 *
 * ⚠️ Compara em CENTÉSIMOS INTEIROS (`Math.round(x * 100)`), nunca em ponto
 * flutuante direto: `Math.abs(0.65 - 0.6)` e `Math.abs(0.65 - 0.7)` NÃO são
 * iguais em IEEE 754 (`0.050000000000000044` contra `0.04999999999999993`) —
 * o segundo vence por um erro de arredondamento invisível, e 0.65 cairia em
 * 0.7 em vez de 0.6, quebrando "empate → a menor" bem no meio do intervalo.
 */
function arredondarParaLimiarDaTela(v: number): number {
  const centesimos = Math.round(v * 100);
  return LIMIARES_DO_CLASSIFICADOR.reduce((maisProximo, opcao) => {
    const distanciaAtual = Math.abs(centesimos - Math.round(maisProximo * 100));
    const distanciaOpcao = Math.abs(centesimos - Math.round(opcao * 100));
    return distanciaOpcao < distanciaAtual ? opcao : maisProximo;
  });
}

export const nascimentoDoCardSchema = z
  .object({
    modo: z.enum(MODOS_DE_NASCIMENTO_DO_CARD).catch(NASCIMENTO_DO_CARD_PADRAO.modo),
    limiar: z
      .number()
      .min(0.5)
      .max(0.95)
      .transform(arredondarParaLimiarDaTela)
      .catch(NASCIMENTO_DO_CARD_PADRAO.limiar),
  })
  // Função, não objeto: um `.catch({ ...padrao })` calcula UMA vez, no
  // carregamento do módulo, e devolve essa MESMA instância em toda falha —
  // provado, duas leituras de lixo eram `===` e mutar uma contaminava a
  // próxima, entre organizações, no worker de vida longa. A função roda a
  // cada `.parse()` e devolve um objeto novo.
  .catch(() => ({ ...NASCIMENTO_DO_CARD_PADRAO }));
export type NascimentoDoCard = Readonly<z.infer<typeof nascimentoDoCardSchema>>;

export const nascimentoDoCardWriteSchema = z.object({
  modo: z.enum(MODOS_DE_NASCIMENTO_DO_CARD),
  limiar: z
    .number()
    .refine((v) => (LIMIARES_DO_CLASSIFICADOR as readonly number[]).includes(v), "limiar fora das opções"),
});

/** A regra em vigor. Nunca lança. */
export function nascimentoDoCard(settings: unknown): NascimentoDoCard {
  const objeto = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  return nascimentoDoCardSchema.parse(objeto(objeto(settings)?.crm)?.nascimento_do_card ?? {});
}
