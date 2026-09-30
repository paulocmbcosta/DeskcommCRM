/**
 * O DIRETÓRIO DO TELEFONE — quem da organização pode receber uma transferência
 * ou uma ligação interna AGORA, e os times com quantos estão livres (desenho da
 * fase 2, §12.4, D17). Server-only: lê o banco pela conexão da API (a
 * organização vem SEMPRE da sessão) e o "online" de uma leitura só da ARI.
 *
 * A régua de D17, a mesma para a transferência e para a ligação interna — e a
 * mesma que a API confere antes de aceitar o pedido (`situacaoDaPessoa`):
 *  - `offline`: o ramal não está registrado (não há navegador para tocar);
 *  - `em_ligacao`: falando, tocando, ou do outro lado de uma interna;
 *  - `em_pausa`: marcou pausa (ou o heartbeat venceu — `is_available` falso);
 *  - `fora_do_horario`: a agenda PRÓPRIA da pessoa diz que ela não atende agora;
 *  - `disponivel`: nenhum dos anteriores.
 * A ordem é a de quem diz mais: offline antes de tudo (não há como tocar).
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { isWithinSchedule } from "@/lib/routing/eligibility";
import { lerAgenda } from "@/lib/times/agenda";

import type { ClienteAri } from "./ari";
import { donoDoEndpoint } from "./pjsip";
import { situacaoDaLinhaDoTime } from "./repositorio";

export const SITUACOES_DA_PESSOA = ["disponivel", "em_ligacao", "em_pausa", "fora_do_horario", "offline"] as const;
export type SituacaoDaPessoa = (typeof SITUACOES_DA_PESSOA)[number];

export function situacaoDaPessoa(p: {
  online: boolean;
  emLigacao: boolean;
  disponivel: boolean;
  dentroDoHorario: boolean;
}): SituacaoDaPessoa {
  if (!p.online) return "offline";
  if (p.emLigacao) return "em_ligacao";
  if (!p.disponivel) return "em_pausa";
  if (!p.dentroDoHorario) return "fora_do_horario";
  return "disponivel";
}

export interface PessoaDoDiretorio {
  user_id: string;
  nome: string;
  ramal: string | null;
  situacao: SituacaoDaPessoa;
  times: Array<{ id: string; nome: string }>;
}

export interface TimeDoDiretorio {
  id: string;
  nome: string;
  disponiveis: number;
  situacao: "aberto" | "fora_do_horario";
}

export interface Diretorio {
  meu_ramal: string | null;
  pessoas: PessoaDoDiretorio[];
  times: TimeDoDiretorio[];
}

/**
 * Os ramais registrados agora — UMA leitura de `GET /endpoints/PJSIP`. Sem a ARI
 * (instalação sem telefonia, Asterisk fora), ninguém está online: o diretório
 * mostra todos como offline, e a transferência não sai — o que é verdade.
 */
export async function ramaisOnline(ari: Pick<ClienteAri, "pedir"> | null): Promise<Set<string>> {
  if (!ari) return new Set();
  try {
    const eps = await ari.pedir<Array<{ resource?: string; state?: string }>>("GET", "/endpoints/PJSIP");
    const online = new Set<string>();
    for (const ep of eps ?? []) {
      if (ep.state !== "online" || !ep.resource) continue;
      const dono = donoDoEndpoint(ep.resource);
      if (dono?.tipo === "ramal") online.add(dono.id);
    }
    return online;
  } catch {
    return new Set();
  }
}

interface LinhaDaPessoa {
  user_id: string;
  nome: string | null;
  ramal: string | null;
  disponivel: boolean | null;
  agenda: unknown;
  em_ligacao: boolean;
  times: Array<{ id: string; nome: string }> | null;
}

/** As pessoas com papel de atendimento DESTA organização, com a situação de agora. */
export async function lerDiretorio(db: Queryable, org: string, eu: string, agora: Date, online: Set<string>): Promise<Diretorio> {
  const { rows } = await db.query<LinhaDaPessoa>(
    `select uo.user_id,
            coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), u.email) as nome,
            e."number" as ramal,
            a.is_available as disponivel,
            a.schedule as agenda,
            exists (
              select 1 from voice_calls v
               where v.organization_id = $1 and v.status <> 'ended'
                 and (v.owner_user_id = uo.user_id or v.ringing_user_id = uo.user_id or v.peer_user_id = uo.user_id)
                 and v.started_at > now() - interval '4 hours'
            ) as em_ligacao,
            (select json_agg(json_build_object('id', t.id, 'nome', t.name) order by t.name)
               from attendance_team_members m
               join attendance_teams t on t.id = m.team_id and t.organization_id = m.organization_id and t.archived_at is null
              where m.organization_id = $1 and m.user_id = uo.user_id) as times
       from user_organizations uo
       join auth.users u on u.id = uo.user_id
       left join phone_extensions e on e.organization_id = uo.organization_id and e.user_id = uo.user_id
       left join attendant_availability a on a.organization_id = uo.organization_id and a.user_id = uo.user_id
      where uo.organization_id = $1 and uo.revoked_at is null and uo.role in ('agent', 'manager', 'admin')
      order by nome`,
    [org],
  );

  const pessoas: PessoaDoDiretorio[] = rows.map((r) => {
    const { agenda, valida } = lerAgenda(r.agenda ?? {});
    return {
      user_id: r.user_id,
      nome: r.nome ?? "",
      ramal: r.ramal,
      situacao: situacaoDaPessoa({
        online: online.has(r.user_id),
        emLigacao: r.em_ligacao,
        disponivel: r.disponivel === true,
        dentroDoHorario: valida && isWithinSchedule(agenda, agora),
      }),
      times: r.times ?? [],
    };
  });

  const { rows: times } = await db.query<{ id: string; nome: string; schedule: unknown; archived_at: string | null }>(
    `select id, name as nome, schedule, archived_at from attendance_teams
      where organization_id = $1 and archived_at is null order by name`,
    [org],
  );
  const livresPorTime = new Map<string, number>();
  for (const p of pessoas) {
    if (p.situacao !== "disponivel") continue;
    for (const t of p.times) livresPorTime.set(t.id, (livresPorTime.get(t.id) ?? 0) + 1);
  }
  return {
    meu_ramal: pessoas.find((p) => p.user_id === eu)?.ramal ?? null,
    pessoas,
    times: times.map((t) => {
      const situacao = situacaoDaLinhaDoTime(t, agora);
      return {
        id: t.id,
        nome: t.nome,
        // Agenda ilegível não é "fora do horário" (a mesma régua da fila): o time aparece aberto.
        situacao: situacao === "fora_do_horario" ? "fora_do_horario" : "aberto",
        disponiveis: situacao === "fora_do_horario" ? 0 : (livresPorTime.get(t.id) ?? 0),
      };
    }),
  };
}
