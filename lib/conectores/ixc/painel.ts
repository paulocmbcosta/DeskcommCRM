/**
 * O QUE O PAINEL DO IXC MOSTRA PARA ESTE CONTATO — a máquina de estados, sem HTTP.
 *
 *   vinculado ............ já se sabe quem é: devolve o resumo.
 *   escolher ............. ninguém vincula sozinho — por três motivos possíveis
 *                          (`MotivoDeEscolher`): o telefone bate com 2+
 *                          cadastros (marido e mulher dividem o celular); o
 *                          telefone foi DIGITADO neste canal e não prova nada
 *                          (chat do site); ou não dá para saber se o canal
 *                          prova identidade (aba antiga, provider que esta
 *                          imagem não conhece). Abrir o financeiro do cadastro
 *                          errado é vazar dado de outra pessoa para o
 *                          atendente falar em voz alta.
 *   nao_encontrado ....... o telefone não está no IXC (o cliente escreveu de
 *                          outro número — é comum). A tela oferece o CPF/CNPJ.
 *   vinculo_sem_cadastro . o vínculo aponta para um id que o IXC não devolve mais.
 *
 * Um ÚNICO candidato pelo telefone vincula sozinho (`verificado_por = telefone`)
 * — mas SÓ quando `identidadeDoTelefone` (de `lib/channels/capabilities.ts`) é
 * `"sim"`. É TRI-ESTADO, não booleano: `"nao"` é o chat do site, onde o número
 * foi DIGITADO e não prova nada; `"desconhecido"` é "não dá para saber" (sem
 * `?conversa=` na URL, provider que esta imagem não reconhece) — e as duas
 * bloqueiam vínculo NOVO da mesma forma, mas só `"nao"` autoriza descartar um
 * vínculo por telefone JÁ GRAVADO. Colapsar as duas custou caro: uma aba
 * antiga aberta sem `?conversa=` fazia todo WhatsApp vinculado por telefone
 * parecer "nunca foi identidade" e cair num beco sem saída (ver `vincular` em
 * `lib/conectores/vinculos.ts`).
 *
 * Quem chama resolve autenticação, organização e contato; esta peça recebe tudo
 * pronto e devolve o estado. É o que a fase da IA vai reusar sem passar por rota.
 */
import type { IdentidadeDoTelefone } from "@/lib/channels/capabilities";
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
 *   varios_cadastros ....... identidadeDoTelefone é "sim", e bateu com 2+
 *                            cadastros (marido e mulher, recadastro). O
 *                            atendente confirma QUAL.
 *   telefone_digitado ...... identidadeDoTelefone é "nao": o número foi
 *                            DIGITADO neste canal (chat do site) e não prova
 *                            nada — mesmo com 1 candidato só, não vincula
 *                            sozinho. O atendente confirma SE É.
 *   canal_nao_identificado . identidadeDoTelefone é "desconhecido": não dá
 *                            para saber se este canal prova identidade (aba
 *                            antiga, provider fora da matriz). Frase NEUTRA —
 *                            não afirma que foi digitado, porque pode não ter
 *                            sido.
 */
export type MotivoDeEscolher = "varios_cadastros" | "telefone_digitado" | "canal_nao_identificado";

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
  /**
   * O telefone é identidade no canal da conversa aberta — tri-estado. Sem
   * conversa conhecida (ou canal fora da matriz) é `"desconhecido"`, NUNCA
   * `"nao"`: só `"nao"` autoriza descartar um vínculo por telefone já gravado.
   */
  identidadeDoTelefone: IdentidadeDoTelefone;
  /** Qual dos cadastros vinculados mostrar; ignorado se não for um deles. */
  cadastroPedido?: string | null;
  agora?: Date;
}

export async function estadoDoPainelIxc(p: PedidoDoPainel): Promise<EstadoDoPainelIxc> {
  let vinculos: Vinculo[] = await listarVinculos(p.admin, p.orgId, p.contactId, "ixc");
  let vinculouAgora = false;

  // O vínculo por telefone só é descartado quando o telefone SABIDAMENTE não é
  // identidade do canal ("nao" — chat do site). "desconhecido" (sem conversa
  // conhecida, provider fora da matriz) NÃO descarta: um vínculo de WhatsApp de
  // verdade não pode sumir só porque esta leitura não conseguiu confirmar o
  // canal. Ver o cabeçalho do arquivo e `vincular` em `../vinculos`.
  vinculos = vinculos.filter((v) => v.verificado_por !== "telefone" || p.identidadeDoTelefone !== "nao");

  if (vinculos.length === 0) {
    const candidatos = await clientesPorTelefone(p.credencial, p.telefone);
    if (candidatos.length === 0) {
      return { estado: "nao_encontrado", procurou_por_telefone: Boolean(p.telefone) };
    }
    const unico = candidatos.length === 1 && p.identidadeDoTelefone === "sim" ? candidatos[0] : undefined;
    if (!unico) {
      const motivo: MotivoDeEscolher =
        p.identidadeDoTelefone === "sim"
          ? "varios_cadastros"
          : p.identidadeDoTelefone === "nao"
            ? "telefone_digitado"
            : "canal_nao_identificado";
      return {
        estado: "escolher",
        motivo,
        candidatos: candidatos.slice(0, TETO_DE_CANDIDATOS).map(candidatoNaTela),
        ha_mais: candidatos.length > TETO_DE_CANDIDATOS,
      };
    }
    vinculouAgora = (
      await vincular({
        admin: p.admin,
        orgId: p.orgId,
        contactId: p.contactId,
        conector: "ixc",
        externalId: unico.id,
        verificadoPor: "telefone",
        userId: null,
      })
    ).vinculou;
    // Cosmético: assume `verificado_por: "telefone"` para montar a resposta
    // desta leitura. Num pedido CONCORRENTE que já tenha criado a linha como
    // "documento"/"manual", `vincular` não promove nada (telefone é a mais
    // fraca — nunca sobrescreve) e a aba mostra "telefone" até o refetch, que
    // lê a linha de verdade do banco.
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
