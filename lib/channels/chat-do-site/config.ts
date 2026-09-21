/**
 * A aparência e o comportamento do widget de chat do site — o schema CENTRAL.
 *
 * `channel_sessions.site_widget_config` é jsonb, e jsonb sem schema central é o
 * anti-pattern 6 do CLAUDE.md: a tela lê um path, a rota pública lê outro, e
 * no dia em que um campo muda de nome metade do produto continua lendo o
 * velho. Aqui há UMA forma e três leitores — a tela de configuração, a rota
 * pública que entrega a configuração ao widget e o teste que prende as duas.
 *
 * ─── Por que `lerConfig` NUNCA lança ────────────────────────────────────────
 *
 * Quem chama é a rota pública, no site de um terceiro. Um jsonb gravado por uma
 * versão anterior (campo a menos, cor inválida editada à mão no banco) não pode
 * derrubar o widget no ar: o visitante veria o site do cliente sem o balão, e
 * ninguém do outro lado saberia. Campo ilegível cai no padrão, campo a campo —
 * o mesmo desenho de `lib/branding/instalacao.ts`.
 *
 * A ESCRITA é o contrário: `configDoWidgetSchema` é estrito e a rota devolve
 * 422. Tolerar na leitura e exigir na escrita é o que impede o lixo de entrar
 * sem punir quem já o tem.
 */
import { z } from "zod";

import { melhorFrenteSobre } from "@/lib/branding/contraste";
import { ehHexValido, normalizarHex } from "@/lib/branding/rampa";

/** O campo do formulário inicial: não pede, pede sem obrigar, ou exige. */
export const MODOS_DO_CAMPO = ["oculto", "opcional", "obrigatorio"] as const;
export type ModoDoCampo = (typeof MODOS_DO_CAMPO)[number];

export const POSICOES_DO_WIDGET = ["direita", "esquerda"] as const;
export type PosicaoDoWidget = (typeof POSICOES_DO_WIDGET)[number];

/** Idiomas em que o widget sabe escrever os textos FIXOS (botão, erros). */
export const IDIOMAS_DO_WIDGET = ["pt", "es", "en"] as const;
export type IdiomaDoWidget = (typeof IDIOMAS_DO_WIDGET)[number];

const hex = z
  .string()
  .trim()
  // O validador de hex é o do domínio de cor, não um regex recém-escrito aqui:
  // duas definições de "hex válido" divergem, e a divergência aparece como cor
  // aceita na tela e recusada na rota.
  .refine(ehHexValido, { message: "cor não é um hex válido" })
  .transform(normalizarHex);

/**
 * Domínio puro: `exemplo.com.br`, `loja.exemplo.com`, `localhost`. Sem esquema,
 * sem caminho, sem porta — é o `hostname` que o navegador manda no `Origin`.
 * Curinga de subdomínio é `*.exemplo.com`.
 */
const dominio = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, {
    message: "domínio inválido — use só o endereço, como exemplo.com.br",
  });

export const configDoWidgetSchema = z
  .object({
    titulo: z.string().trim().min(1).max(60),
    subtitulo: z.string().trim().max(120),
    mensagem_de_boas_vindas: z.string().trim().max(500),
    cor_principal: hex,
    posicao: z.enum(POSICOES_DO_WIDGET),
    idioma: z.enum(IDIOMAS_DO_WIDGET),
    formulario_inicial: z.object({
      nome: z.enum(MODOS_DO_CAMPO),
      email: z.enum(MODOS_DO_CAMPO),
      telefone: z.enum(MODOS_DO_CAMPO),
    }),
    /** Vazio = qualquer site. Ver `origemPermitida`. */
    dominios_permitidos: z.array(dominio).max(20),
  })
  .strict();

export type ConfigDoWidget = z.infer<typeof configDoWidgetSchema>;

/**
 * O padrão de um widget recém-criado.
 *
 * Pede NOME (obrigatório) e telefone/e-mail (opcionais) por um motivo de
 * negócio, não de gosto: o visitante que fecha a aba some. Sem um jeito de
 * voltar a falar com ele, a conversa do site é a única do CRM que o follow-up
 * não alcança — o anti-morte (invariante 4 do sistema vivo) depende deste
 * formulário. Quem prefere atrito zero desliga os três na tela.
 *
 * A cor é neutra de propósito: nenhuma marca mora no código (white-label).
 */
export const CONFIG_PADRAO_DO_WIDGET: ConfigDoWidget = {
  titulo: "Fale com a gente",
  subtitulo: "Respondemos o mais rápido possível",
  mensagem_de_boas_vindas: "Olá! Como podemos ajudar?",
  cor_principal: "#2563eb",
  posicao: "direita",
  idioma: "pt",
  formulario_inicial: { nome: "obrigatorio", email: "opcional", telefone: "opcional" },
  dominios_permitidos: [],
};

function texto(valor: unknown, max: number, padrao: string, aceitaVazio: boolean): string {
  if (typeof valor !== "string") return padrao;
  const limpo = valor.trim().slice(0, max);
  return limpo.length === 0 && !aceitaVazio ? padrao : limpo;
}

function umDe<T extends string>(valor: unknown, opcoes: readonly T[], padrao: T): T {
  return typeof valor === "string" && (opcoes as readonly string[]).includes(valor)
    ? (valor as T)
    : padrao;
}

/**
 * Lê o jsonb do banco, campo a campo, sem lançar.
 *
 * Campo a campo e não `safeParse` do objeto inteiro: com o parse inteiro, UMA
 * cor inválida descartaria também o título, a boas-vindas e a posição que
 * estavam certos, e o dono veria o widget "resetado" sem entender por quê.
 */
export function lerConfig(bruto: unknown): ConfigDoWidget {
  const p = CONFIG_PADRAO_DO_WIDGET;
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return { ...p };
  const o = bruto as Record<string, unknown>;
  const f =
    o.formulario_inicial && typeof o.formulario_inicial === "object"
      ? (o.formulario_inicial as Record<string, unknown>)
      : {};

  const dominios = Array.isArray(o.dominios_permitidos)
    ? o.dominios_permitidos
        .map((d) => dominio.safeParse(d))
        .flatMap((r) => (r.success ? [r.data] : []))
        .slice(0, 20)
    : [];

  return {
    titulo: texto(o.titulo, 60, p.titulo, false),
    subtitulo: texto(o.subtitulo, 120, p.subtitulo, true),
    mensagem_de_boas_vindas: texto(o.mensagem_de_boas_vindas, 500, p.mensagem_de_boas_vindas, true),
    cor_principal:
      typeof o.cor_principal === "string" && ehHexValido(o.cor_principal.trim())
        ? normalizarHex(o.cor_principal.trim())
        : p.cor_principal,
    posicao: umDe(o.posicao, POSICOES_DO_WIDGET, p.posicao),
    idioma: umDe(o.idioma, IDIOMAS_DO_WIDGET, p.idioma),
    formulario_inicial: {
      nome: umDe(f.nome, MODOS_DO_CAMPO, p.formulario_inicial.nome),
      email: umDe(f.email, MODOS_DO_CAMPO, p.formulario_inicial.email),
      telefone: umDe(f.telefone, MODOS_DO_CAMPO, p.formulario_inicial.telefone),
    },
    dominios_permitidos: dominios,
  };
}

/**
 * O que o widget recebe — a configuração MENOS o que é só do dono.
 *
 * `dominios_permitidos` fica de fora: quem decide é o servidor, e entregar a
 * lista a qualquer visitante seria publicar a relação de sites do cliente.
 *
 * `cor_do_texto` é CALCULADA, nunca configurada: branco sobre um amarelo de
 * marca é ilegível, e é justamente a cor que o cliente cola sem avisar. Preto
 * ou branco sempre passa do piso de 4,5 (ver `lib/branding/contraste.ts`).
 */
export interface ConfigPublicaDoWidget {
  titulo: string;
  subtitulo: string;
  mensagem_de_boas_vindas: string;
  cor_principal: string;
  cor_do_texto: string;
  posicao: PosicaoDoWidget;
  idioma: IdiomaDoWidget;
  formulario_inicial: ConfigDoWidget["formulario_inicial"];
}

export function configPublica(config: ConfigDoWidget): ConfigPublicaDoWidget {
  return {
    titulo: config.titulo,
    subtitulo: config.subtitulo,
    mensagem_de_boas_vindas: config.mensagem_de_boas_vindas,
    cor_principal: config.cor_principal,
    cor_do_texto: melhorFrenteSobre(config.cor_principal),
    posicao: config.posicao,
    idioma: config.idioma,
    formulario_inicial: config.formulario_inicial,
  };
}

/**
 * O `Origin` do pedido está na lista do dono?
 *
 * ─── O que isto É e o que NÃO é ─────────────────────────────────────────────
 *
 * É uma cerca para NAVEGADOR: impede que outro site incorpore o widget de um
 * cliente e gaste o atendimento dele. NÃO é autenticação — um script fora do
 * navegador escreve o `Origin` que quiser. Quem segura abuso de verdade é o
 * rate limit da rota; isto só fecha a porta do uso casual, e é por isso que a
 * lista vazia significa "qualquer site" em vez de "nenhum": widget recém-criado
 * precisa funcionar no primeiro site em que for colado, sem um passo extra que
 * a tela não tinha como adivinhar.
 *
 * Pedido SEM `Origin` com lista preenchida é recusado: navegador sempre manda
 * `Origin` em `fetch` entre origens, então a ausência é justamente o cliente
 * que não é navegador.
 */
export function origemPermitida(origin: string | null, dominios: readonly string[]): boolean {
  if (dominios.length === 0) return true;
  if (!origin) return false;

  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }

  return dominios.some((d) => {
    if (d.startsWith("*.")) {
      const base = d.slice(2);
      // `*.exemplo.com` cobre `loja.exemplo.com` e o próprio `exemplo.com`:
      // quem escreve o curinga quer "o meu site inteiro", e exigir a segunda
      // linha só para o domínio nu seria uma pegadinha.
      return host === base || host.endsWith(`.${base}`);
    }
    // `www.` é o mesmo site para quem configura. Sem isto, `exemplo.com` na
    // lista e o site servido em `www.exemplo.com` dava widget mudo — o defeito
    // de primeira impressão mais provável desta tela.
    return host === d || host === `www.${d}` || `www.${host}` === d;
  });
}
