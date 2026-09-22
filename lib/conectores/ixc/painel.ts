/**
 * O QUE O PAINEL DO IXC MOSTRA PARA ESTE CONTATO — a máquina de estados, sem HTTP.
 *
 *   vinculado ............ já se sabe quem é: devolve o resumo.
 *   escolher ............. ninguém vincula sozinho — por dois motivos possíveis
 *                          (`MotivoDeEscolher`): o telefone bate com 2+
 *                          cadastros (marido e mulher dividem o celular), ou o
 *                          telefone não é identidade neste canal (visitante do
 *                          chat do site). Abrir o financeiro do cadastro errado
 *                          é vazar dado de outra pessoa para o atendente falar
 *                          em voz alta.
 *   nao_encontrado ....... o telefone não está no IXC (o cliente escreveu de
 *                          outro número — é comum). A tela oferece o CPF/CNPJ.
 *   vinculo_sem_cadastro . o vínculo aponta para um id que o IXC não devolve mais.
 *
 * Um ÚNICO candidato pelo telefone vincula sozinho (`verificado_por = telefone`)
 * — mas SÓ onde o telefone é a identidade do canal (`telefoneEhIdentidade`, de
 * `lib/channels/capabilities.ts`). No WhatsApp o número da conversa é a prova; no
 * chat do site ele foi DIGITADO pelo visitante e não prova nada: lá o candidato
 * aparece em "escolher", e quem confirma é o atendente.
 *
 * Quem chama resolve autenticação, organização e contato; esta peça recebe tudo
 * pronto e devolve o estado. É o que a fase da IA vai reusar sem passar por rota.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

import type { CredencialDeConector, FormaDeVerificacao } from "../tipos";
import { listarVinculos, vincular, type Vinculo } from "../vinculos";
import {
  TETO_DE_CANDIDATOS,
  clientePorId,
  clientesPorTelefone,
  documentoParcial,
  type ClienteIxc,
} from "./identificar";
import { montarResumo, type ResumoIxc } from "./resumo";

type Admin = ReturnType<typeof createAdminClient>;

export interface CandidatoNaTela {
  id: string;
  nome: string;
  documento_parcial: string;
  ativo: boolean;
}

export interface CadastroVinculado {
  id: string;
  /** Vazio quando o IXC não devolveu o cadastro (a aba mostra só o número). */
  nome: string;
  verificado_por: FormaDeVerificacao;
}

/**
 * Por que a tela caiu em "escolher": a pergunta muda a frase que o atendente lê.
 *
 *   varios_cadastros ... o telefone É identidade aqui, e bateu com 2+ cadastros
 *                        (marido e mulher, recadastro). O atendente confirma QUAL.
 *   telefone_nao_prova . o telefone NÃO é identidade neste canal (foi digitado
 *                        pelo visitante do chat do site) — mesmo com 1 candidato
 *                        só, ele não vincula sozinho. O atendente confirma SE É.
 */
export type MotivoDeEscolher = "varios_cadastros" | "telefone_nao_prova";

export type EstadoDoPainelIxc =
  | { estado: "vinculado"; cadastros: CadastroVinculado[]; cadastro_em_tela: string; resumo: ResumoIxc; vinculou_agora: boolean }
  | { estado: "escolher"; motivo: MotivoDeEscolher; candidatos: CandidatoNaTela[]; ha_mais: boolean }
  | { estado: "nao_encontrado"; procurou_por_telefone: boolean }
  | { estado: "vinculo_sem_cadastro"; cadastros: CadastroVinculado[]; cadastro_em_tela: string };

export function candidatoNaTela(c: ClienteIxc): CandidatoNaTela {
  return { id: c.id, nome: c.nome, documento_parcial: documentoParcial(c.documento), ativo: c.ativo };
}

export interface PedidoDoPainel {
  admin: Admin;
  credencial: CredencialDeConector;
  orgId: string;
  contactId: string;
  telefone: string | null;
  /** O telefone é identidade no canal da conversa aberta? Sem conversa conhecida: `false`. */
  telefoneEhIdentidade: boolean;
  /** Qual dos cadastros vinculados mostrar; ignorado se não for um deles. */
  cadastroPedido?: string | null;
  agora?: Date;
}

export async function estadoDoPainelIxc(p: PedidoDoPainel): Promise<EstadoDoPainelIxc> {
  let vinculos: Vinculo[] = await listarVinculos(p.admin, p.orgId, p.contactId, "ixc");
  let vinculouAgora = false;

  // O vínculo por telefone só vale onde o telefone é identidade do canal: um
  // vínculo criado pelo furo antigo (visitante do chat do site, número digitado)
  // não pode continuar valendo como "já sei quem é" para sempre. Descartado, o
  // contato volta para o fluxo de identificação normal.
  vinculos = vinculos.filter((v) => v.verificado_por !== "telefone" || p.telefoneEhIdentidade);

  if (vinculos.length === 0) {
    const candidatos = await clientesPorTelefone(p.credencial, p.telefone);
    if (candidatos.length === 0) {
      return { estado: "nao_encontrado", procurou_por_telefone: Boolean(p.telefone) };
    }
    const unico = candidatos.length === 1 && p.telefoneEhIdentidade ? candidatos[0] : undefined;
    if (!unico) {
      return {
        estado: "escolher",
        motivo: p.telefoneEhIdentidade ? "varios_cadastros" : "telefone_nao_prova",
        candidatos: candidatos.slice(0, TETO_DE_CANDIDATOS).map(candidatoNaTela),
        ha_mais: candidatos.length > TETO_DE_CANDIDATOS,
      };
    }
    vinculouAgora = await vincular({
      admin: p.admin,
      orgId: p.orgId,
      contactId: p.contactId,
      conector: "ixc",
      externalId: unico.id,
      verificadoPor: "telefone",
      userId: null,
    });
    vinculos = [{ external_id: unico.id, verificado_por: "telefone", created_at: new Date().toISOString() }];
  }

  const emTela =
    vinculos.find((v) => v.external_id === p.cadastroPedido)?.external_id ?? vinculos[0]?.external_id ?? "";
  const outros = vinculos.filter((v) => v.external_id !== emTela).slice(0, 4);

  // O resumo e os NOMES dos outros cadastros saem juntos: a aba de quem cuida de
  // duas contas precisa dizer "Maria" e "José", não "cadastro 1234".
  const [resumo, ...nomes] = await Promise.all([
    montarResumo(p.credencial, emTela, p.agora),
    ...outros.map((v) => clientePorId(p.credencial, v.external_id).catch(() => null)),
  ]);

  const cadastros: CadastroVinculado[] = vinculos.map((v) => {
    const i = outros.findIndex((o) => o.external_id === v.external_id);
    const nome = v.external_id === emTela ? (resumo?.cliente.nome ?? "") : ((i >= 0 ? nomes[i]?.nome : "") ?? "");
    return { id: v.external_id, nome, verificado_por: v.verificado_por };
  });

  if (!resumo) return { estado: "vinculo_sem_cadastro", cadastros, cadastro_em_tela: emTela };
  return { estado: "vinculado", cadastros, cadastro_em_tela: emTela, resumo, vinculou_agora: vinculouAgora };
}
