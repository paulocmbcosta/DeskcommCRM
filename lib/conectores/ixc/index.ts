/**
 * O CONECTOR IXC — o que o registro enxerga dele.
 *
 * Tudo o que é específico do IXC mora nesta pasta. O núcleo importa só o
 * `registro.ts`; as rotas do conector (`app/api/v1/.../conectores/ixc`) e o
 * painel (`components/conectores/ixc`) importam daqui. Vigiado por
 * tests/unit/conectores-cerca.test.ts.
 */
import { FalhaDoConector, type DefinicaoDeConector } from "../tipos";
import { CAMPOS_DO_CLIENTE } from "./campos";
import { listarNoIxc } from "./http";

export const conectorIxc: DefinicaoDeConector = {
  id: "ixc",
  rotulo: "IXC",
  descricao:
    "Sistema de gestão de provedor de internet. Mostra no atendimento o contrato, o bloqueio, as faturas, as ordens de serviço e a conexão do cliente.",
  ajudaDoEndereco: "O endereço que você usa para abrir o IXC. Ex.: https://suaempresa.ixcsoft.com.br",
  ajudaDoToken:
    "Gerado no IXC, no cadastro de usuário com acesso à API. Peça um token SÓ DE LEITURA, dedicado a esta integração.",

  /**
   * A menor leitura que prova as duas coisas de uma vez: o host é um IXC e o
   * token alcança `cliente` — a tabela sem a qual o painel não tem de quem falar.
   */
  async testar(credencial) {
    try {
      await listarNoIxc(credencial, {
        tabela: "cliente",
        filtro: { campo: "cliente.id", operador: ">=", valor: "1" },
        campos: CAMPOS_DO_CLIENTE,
        limite: 1,
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof FalhaDoConector) return { ok: false, motivo: err.motivo, detalhe: err.message };
      return { ok: false, motivo: "resposta_inesperada", detalhe: "erro_nao_classificado" };
    }
  },
};
