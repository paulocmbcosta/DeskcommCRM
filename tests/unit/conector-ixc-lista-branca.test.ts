/**
 * A LISTA BRANCA DO IXC NÃO PEDE SEGREDO — E ISSO SE MEDE.
 *
 * A API do IXC não tem projeção de campos: `listar` devolve a linha inteira, e a
 * linha inteira traz senha EM CLARO. Medido numa instância real em 2026-09-19:
 * `cliente.senha` (central do assinante), `cliente.senha_hotsite_md5`,
 * `radusuarios.senha` (PPPoE), `radusuarios.senha_rede_sem_fio` (o Wi-Fi da casa
 * da pessoa), `senha_router1`, `radpop_radio_cliente_fibra.senha_onu_cliente`,
 * `cliente_contrato.credit_card_recorrente_token`, `fn_areceber.gerencianet_token`.
 *
 * Quem decide o que sai do conector é `lib/conectores/ixc/campos.ts`. O modo de
 * falha que este arquivo impede é o mais natural do mundo: alguém precisa de "só
 * mais um campo" para o suporte, acrescenta `senha_rede_sem_fio` porque o
 * atendente vive pedindo, e a senha do Wi-Fi de 8 mil clientes passa a trafegar
 * até o navegador — e, na fase seguinte, até o contexto da IA.
 */
import { describe, expect, it } from "vitest";

import { CAMPOS_DA_CONFERENCIA, CAMPOS_DO_CLIENTE, LISTAS_BRANCAS } from "@/lib/conectores/ixc/campos";

const SEGREDO = /senha|password|passwd|token|secret|md5|hash|credit_card|cartao|cvv/i;

describe("lista branca do conector IXC", () => {
  it("a varredura não é vazia", () => {
    const total = Object.values(LISTAS_BRANCAS).reduce((n, campos) => n + campos.length, 0);
    expect(Object.keys(LISTAS_BRANCAS).length).toBeGreaterThanOrEqual(7);
    expect(total).toBeGreaterThan(40);
  });

  it.each(Object.entries(LISTAS_BRANCAS))("%s não pede nenhum campo com cara de segredo", (_tabela, campos) => {
    expect(campos.filter((c) => SEGREDO.test(c))).toEqual([]);
  });

  it("controle positivo: a régua PEGA os campos reais que o IXC devolve", () => {
    const reais = ["senha", "senha_hotsite_md5", "senha_rede_sem_fio", "senha_onu_cliente", "credit_card_recorrente_token", "gerencianet_token"];
    expect(reais.filter((c) => !SEGREDO.test(c))).toEqual([]);
  });

  it("a data de nascimento só sai na lista da CONFERÊNCIA, nunca na do painel/navegador", () => {
    expect(CAMPOS_DO_CLIENTE).not.toContain("data_nascimento");
    expect(CAMPOS_DA_CONFERENCIA).toContain("data_nascimento");
  });
});
