/**
 * A LISTA BRANCA — o que o conector LÊ de cada tabela do IXC.
 *
 * A API não tem projeção: `listar` devolve a linha inteira, e a linha inteira
 * inclui senha em claro — `cliente.senha` (central do assinante),
 * `radusuarios.senha` (PPPoE), `senha_rede_sem_fio` (o Wi-Fi da casa da pessoa),
 * `senha_onu_cliente`. `listarNoIxc` descarta o que não estiver aqui ANTES de
 * devolver. Acrescentar um campo é decisão, não conveniência: a pergunta é "o
 * atendente precisa disto para atender?", e a resposta para qualquer `senha*` é
 * não. Vigiado por tests/unit/conector-ixc-lista-branca.test.ts.
 */
export const CAMPOS_DO_CLIENTE = [
  "id",
  "razao",
  "fantasia",
  "cnpj_cpf",
  "tipo_pessoa",
  "ativo",
  "telefone_celular",
  "whatsapp",
  "telefone_comercial",
  "fone",
] as const;

/**
 * `cliente` + a data de nascimento — SÓ para a conferência de identidade da IA
 * (CPF + nascimento, decisão do dono de 21/09). Lista separada de propósito: a
 * data não entra em `CAMPOS_DO_CLIENTE`, que alimenta o painel e o navegador.
 * Formato medido no IXC real em 22/09: sempre `AAAA-MM-DD`; vazio = `0000-00-00`.
 */
export const CAMPOS_DA_CONFERENCIA = [...CAMPOS_DO_CLIENTE, "data_nascimento"] as const;

export const CAMPOS_DO_CONTRATO = [
  "id",
  "id_cliente",
  "contrato",
  "status",
  "status_internet",
  "data_ativacao",
  "data_cancelamento",
  "contrato_suspenso",
  "desbloqueio_confianca",
  "desbloqueio_confianca_ativo",
  "num_parcelas_atraso",
  "pago_ate_data",
  "endereco",
  "numero",
  "bairro",
] as const;

export const CAMPOS_DA_FATURA = [
  "id",
  "id_cliente",
  "id_contrato",
  "status",
  "data_vencimento",
  "valor",
  "valor_aberto",
  "linha_digitavel",
  // Só para saber SE a fatura tem Pix registrado — o copia-e-cola vem de
  // `get_pix`, na hora de enviar. (`gateway_link` saiu: era o boleto no site do
  // banco, e o que se envia é o PDF do próprio IXC.)
  "pix_txid",
  "documento",
] as const;

export const CAMPOS_DO_LOGIN = [
  "id",
  "id_cliente",
  "id_contrato",
  "login",
  "ativo",
  "online",
  "ip",
  "mac",
  "ultima_conexao_inicial",
  "ultima_conexao_final",
  "tempo_conectado",
  "motivo_desconexao",
] as const;

export const CAMPOS_DA_FIBRA = [
  "id",
  "id_login",
  "id_contrato",
  "sinal_rx",
  "sinal_tx",
  "data_sinal",
  "temperatura",
  "voltagem",
  "distancia_onu",
  "causa_ultima_queda",
] as const;

export const CAMPOS_DA_OS = [
  "id",
  "id_cliente",
  "protocolo",
  "status",
  "prioridade",
  "data_abertura",
  "data_agenda",
  "mensagem",
] as const;

export const CAMPOS_DO_TICKET = [
  "id",
  "id_cliente",
  "protocolo",
  "titulo",
  "su_status",
  "prioridade",
  "data_criacao",
] as const;

/** Todas as listas, para o teste varrer de uma vez. */
export const LISTAS_BRANCAS = {
  cliente: CAMPOS_DO_CLIENTE,
  "cliente (conferência)": CAMPOS_DA_CONFERENCIA,
  cliente_contrato: CAMPOS_DO_CONTRATO,
  fn_areceber: CAMPOS_DA_FATURA,
  radusuarios: CAMPOS_DO_LOGIN,
  radpop_radio_cliente_fibra: CAMPOS_DA_FIBRA,
  su_oss_chamado: CAMPOS_DA_OS,
  su_ticket: CAMPOS_DO_TICKET,
} as const;
