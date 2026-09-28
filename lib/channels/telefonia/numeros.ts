/**
 * Os números de telefone da organização — o cadastro que a tela de Conexões ›
 * Telefone faz (spec 20 §7). Um número = uma linha de `channel_sessions` com o
 * provider do tronco SIP.
 *
 * A senha entra em claro SÓ aqui, é cifrada DENTRO do mesmo comando SQL
 * (`fn_encrypt_oauth`) e nunca é lida de volta por este módulo: a leitura
 * pública (`numerosDaOrg`) não seleciona a coluna. Editar sem mandar senha
 * mantém a que está guardada — mas só enquanto a CONTA é a mesma (ver
 * `atualizarNumero`).
 */
import { z } from "zod";

import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { numeroParaLigar } from "@/lib/telefonia/numero";

import { motivoDoServidorInvalido, normalizarServidor, usuarioSipValido } from "./conta-sip";
import { PROVIDER } from "./repositorio";

export const numeroSchema = z
  .object({
    nome: z.string().trim().min(1).max(80),
    numero: z.string().trim().min(8).max(30),
    // A MESMA régua que o worker aplica antes de empurrar o tronco
    // (`conta-sip.ts`): a coluna também é gravável pela REST, sem este Zod.
    servidor: z
      .string()
      .transform(normalizarServidor)
      .superRefine((s, ctx) => {
        const motivo = motivoDoServidorInvalido(s);
        if (motivo === "interno") {
          ctx.addIssue({
            code: "custom",
            message: "Use o endereço público da operadora — endereço interno, localhost ou nome sem domínio não são aceitos.",
          });
        } else if (motivo) {
          ctx.addIssue({ code: "custom", message: "servidor inválido" });
        }
      }),
    porta: z.coerce.number().int().min(1).max(65535).default(5060),
    transporte: z.enum(["udp", "tcp"]).default("udp"),
    usuario: z.string().trim().refine(usuarioSipValido, "usuário inválido"),
    senha: z.string().min(1).max(128).optional(),
    time_id: z.string().uuid().nullable().default(null),
  })
  .strict();

export type EntradaDoNumero = z.infer<typeof numeroSchema>;

export interface NumeroPublico {
  id: string;
  nome: string | null;
  numero: string | null;
  servidor: string;
  porta: number;
  transporte: "udp" | "tcp";
  usuario: string;
  time_id: string | null;
  time_nome: string | null;
  status: string;
  status_reason: string | null;
  created_at: string;
}

export async function numerosDaOrg(db: Queryable, organizationId: string): Promise<NumeroPublico[]> {
  const { rows } = await db.query<NumeroPublico>(
    `select c.id, c.display_name as nome, c.phone_number as numero, c.sip_server as servidor,
            coalesce(c.sip_port, 5060) as porta, coalesce(c.sip_transport, 'udp') as transporte,
            c.sip_username as usuario, c.sip_team_id as time_id, t.name as time_nome,
            c.status, c.status_reason, c.created_at
       from channel_sessions c
       left join attendance_teams t on t.id = c.sip_team_id and t.organization_id = c.organization_id
      where c.organization_id = $1 and c.provider = $2 and c.archived_at is null
      order by c.created_at asc`,
    [organizationId, PROVIDER],
  );
  return rows;
}

export type FalhaDoCadastro =
  | "numero_invalido"
  | "time_invalido"
  | "senha_obrigatoria"
  | "senha_obrigatoria_na_troca"
  | "numero_ja_existe"
  | "conta_ja_usada"
  | "nao_encontrado";

/**
 * O número exibido (DID) em E.164. Geográfico com DDD pela régua da discagem;
 * 0800 e 400x também valem aqui — são números que empresa CONTRATA para receber,
 * mesmo que o CRM não disque para eles.
 */
function e164DoNumero(bruto: string): string | null {
  const n = numeroParaLigar(bruto);
  if (n.ok) return n.e164;
  if (n.motivo !== "nao_geografico") return null;
  const d = bruto.replace(/\D/g, "").replace(/^0/, "");
  return d.length >= 7 && d.length <= 11 ? `+55${d}` : null;
}

async function timeDaOrg(db: Queryable, organizationId: string, timeId: string | null): Promise<boolean> {
  if (!timeId) return true;
  const { rows } = await db.query(
    "select 1 from attendance_teams where id = $1 and organization_id = $2 and archived_at is null",
    [timeId, organizationId],
  );
  return rows.length > 0;
}

function traduzirConflito(e: unknown): FalhaDoCadastro | null {
  const err = e as { code?: string; constraint?: string };
  if (err.code !== "23505") return null;
  if (err.constraint === "channel_sessions_sip_conta_unique") return "conta_ja_usada";
  return "numero_ja_existe";
}

export async function criarNumero(
  db: Queryable,
  organizationId: string,
  e: EntradaDoNumero,
): Promise<{ ok: true; id: string } | { ok: false; motivo: FalhaDoCadastro }> {
  const numero = e164DoNumero(e.numero);
  if (!numero) return { ok: false, motivo: "numero_invalido" };
  if (!e.senha) return { ok: false, motivo: "senha_obrigatoria" };
  if (!(await timeDaOrg(db, organizationId, e.time_id))) return { ok: false, motivo: "time_invalido" };
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into channel_sessions
         (organization_id, provider, webhook_secret_encrypted, status, display_name, phone_number,
          sip_server, sip_port, sip_transport, sip_username, sip_password_encrypted, sip_team_id)
       values ($1, $2, decode('00', 'hex'), 'STARTING', $3, $4, $5, $6, $7, $8,
               public.fn_encrypt_oauth($9), $10)
       returning id`,
      [organizationId, PROVIDER, e.nome, numero, e.servidor, e.porta, e.transporte, e.usuario, e.senha, e.time_id],
    );
    return { ok: true, id: rows[0]!.id };
  } catch (err) {
    const motivo = traduzirConflito(err);
    if (motivo) return { ok: false, motivo };
    throw err;
  }
}

interface ContaGuardada {
  servidor: string;
  porta: number;
  transporte: string;
  usuario: string;
}

/**
 * A senha é da CONTA — usuário naquele servidor, por aquela porta e transporte.
 * Trocar qualquer um dos quatro sem digitar a senha de novo mandaria a senha
 * guardada para outra conta: com o servidor trocado, o Asterisk responde ao
 * desafio de autenticação de QUALQUER host que o admin digitar, e o digest que
 * sai dali é quebrável offline. Quem edita a tela nunca viu a senha (ela só é
 * escrita), então editar não pode ser o jeito de levá-la a outro lugar.
 */
function trocouAConta(guardada: ContaGuardada, e: EntradaDoNumero): boolean {
  return (
    guardada.servidor !== e.servidor ||
    Number(guardada.porta) !== e.porta ||
    guardada.transporte !== e.transporte ||
    guardada.usuario !== e.usuario
  );
}

export async function atualizarNumero(
  db: Queryable,
  organizationId: string,
  id: string,
  e: EntradaDoNumero,
): Promise<{ ok: true } | { ok: false; motivo: FalhaDoCadastro }> {
  const numero = e164DoNumero(e.numero);
  if (!numero) return { ok: false, motivo: "numero_invalido" };
  if (!(await timeDaOrg(db, organizationId, e.time_id))) return { ok: false, motivo: "time_invalido" };

  const { rows: atuais } = await db.query<ContaGuardada>(
    `select lower(sip_server) as servidor, coalesce(sip_port, 5060) as porta,
            coalesce(sip_transport, 'udp') as transporte, sip_username as usuario
       from channel_sessions
      where id = $1 and organization_id = $2 and provider = $3 and archived_at is null`,
    [id, organizationId, PROVIDER],
  );
  const atual = atuais[0];
  if (!atual) return { ok: false, motivo: "nao_encontrado" };
  if (!e.senha && trocouAConta(atual, e)) return { ok: false, motivo: "senha_obrigatoria_na_troca" };

  try {
    // A última cláusula repete a regra de `trocouAConta` DENTRO do comando: sem
    // ela, duas edições simultâneas (uma trocando o servidor com a senha nova,
    // outra salvando o formulário antigo sem senha) terminavam com a senha nova
    // apontada para o servidor antigo.
    const { rowCount } = await db.query(
      `update channel_sessions
          set display_name = $4, phone_number = $5, sip_server = $6, sip_port = $7,
              sip_transport = $8, sip_username = $9, sip_team_id = $10,
              sip_password_encrypted = case when $11::text is null then sip_password_encrypted
                                            else public.fn_encrypt_oauth($11) end,
              status = 'STARTING', status_reason = null, updated_at = now()
        where id = $1 and organization_id = $2 and provider = $3 and archived_at is null
          and ($11::text is not null
               or (lower(sip_server) = $6 and coalesce(sip_port, 5060) = $7
                   and coalesce(sip_transport, 'udp') = $8 and sip_username = $9))`,
      [id, organizationId, PROVIDER, e.nome, numero, e.servidor, e.porta, e.transporte, e.usuario, e.time_id, e.senha ?? null],
    );
    return (rowCount ?? 0) > 0 ? { ok: true } : { ok: false, motivo: "nao_encontrado" };
  } catch (err) {
    const motivo = traduzirConflito(err);
    if (motivo) return { ok: false, motivo };
    throw err;
  }
}

/**
 * Remover = arquivar: as conversas e ligações apontam para esta linha, e o
 * histórico delas não some junto com o número. O Asterisk solta o registro na
 * próxima sincronização (ou na hora, pela rota).
 */
export async function arquivarNumero(db: Queryable, organizationId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `update channel_sessions
        set archived_at = now(), status = 'STOPPED', status_reason = 'removido', updated_at = now()
      where id = $1 and organization_id = $2 and provider = $3 and archived_at is null`,
    [id, organizationId, PROVIDER],
  );
  return (rowCount ?? 0) > 0;
}

export const MENSAGEM_DA_FALHA: Record<FalhaDoCadastro, string> = {
  numero_invalido: "O número precisa ser um telefone brasileiro com DDD.",
  time_invalido: "Esse time não existe nesta organização.",
  senha_obrigatoria: "Informe a senha da conta SIP.",
  senha_obrigatoria_na_troca:
    "Ao trocar o servidor, a porta, o transporte ou o usuário, digite a senha da conta SIP de novo.",
  numero_ja_existe: "Esse número já está conectado nesta organização.",
  conta_ja_usada: "Essa conta SIP já está conectada nesta instalação.",
  nao_encontrado: "Número não encontrado.",
};
