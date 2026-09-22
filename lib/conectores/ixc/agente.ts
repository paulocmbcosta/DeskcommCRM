/**
 * O IXC PARA O AGENTE DE IA — identificar o cliente da conversa e enviar a cobrança.
 *
 * É a implementação de `CapacidadeDoAgente` (lib/conectores/tipos.ts). O motor não
 * sabe que isto é IXC: pede ao registro o conector da organização que declara
 * `agente` e chama `consultar` / `enviarCobranca`. Spec:
 * docs/superpowers/specs/2026-09-22-ia-envia-cobranca-ixc-design.md.
 *
 * Três regras do dono moram aqui porque dependem do que o IXC é:
 *   1. identidade antes de dinheiro (§6): telefone que bate com UM cadastro — e
 *      só num canal em que o telefone É a identidade —; o CPF escolhe entre os
 *      cadastros do telefone; fora disso, CPF + data de nascimento;
 *   2. UMA fatura por vez (§7): a vencida mais antiga, senão a próxima;
 *   3. fatura acima do limite de dias não sai (§7): vai para a Cobrança.
 *
 * O que NÃO mora aqui: contar tentativas, auditar, falar com o modelo. Isso é do
 * motor, que é quem sabe de conversa, atendimento e agente.
 */
import type {
  CapacidadeDoAgente,
  ClienteParaAgente,
  CredencialDeConector,
  FaturaParaAgente,
  FinanceiroParaAgente,
  FormaDeVerificacao,
  PedidoDeCobranca,
  PedidoDeConsulta,
  ResultadoDaCobranca,
  ResultadoDaConsulta,
} from "../tipos";
import { listarVinculos, vincular } from "../vinculos";
import { CAMPOS_DA_FATURA } from "./campos";
import { enviarCobrancaIxc, type ResultadoDoEnvio } from "./enviar-cobranca";
import { faturaDaVez, hojeEmSaoPaulo, recortarFaturas, type Fatura, type RecorteDeFaturas } from "./faturas";
import { listarNoIxc } from "./http";
import { TETO_DE_CANDIDATOS, cadastrosQueConferem, clientesPorTelefone, dataInformada } from "./identificar";
import { documentoNaMascara, soDigitos } from "./mascara";
import { montarResumo, type ContratoIxc, type ResumoIxc } from "./resumo";
import { acessoLiberado } from "./vocabulario";

type Pedido = Pick<PedidoDeConsulta, "admin" | "orgId" | "contactId" | "identidadeDoTelefone">;

/**
 * Os cadastros vinculados que VALEM para a IA. O vínculo `telefone` é descartado
 * onde o telefone SABIDAMENTE não é identidade (antes do conserto de 22/09 o
 * painel vinculava pelo número DIGITADO no chat do site). Canal "desconhecido"
 * NÃO descarta: "não sei" não é "não é" — esconder vínculo legítimo faria a IA
 * pedir CPF a quem já está identificado.
 */
async function cadastrosValidos(p: Pedido): Promise<string[]> {
  const vinculos = await listarVinculos(p.admin, p.orgId, p.contactId, "ixc");
  return vinculos
    .filter((v) => v.verificado_por !== "telefone" || p.identidadeDoTelefone !== "nao")
    .map((v) => v.external_id);
}

function paraAgente(f: Fatura): FaturaParaAgente {
  return { vencimento: f.vencimento, valorCents: f.valorCents, diasDeAtraso: f.diasDeAtraso };
}

/** As faturas ABERTAS de todos os cadastros: "a mais atrasada de todas" olha para todos. */
async function recorteDe(credencial: CredencialDeConector, cadastros: readonly string[], agora?: Date): Promise<RecorteDeFaturas> {
  const listas = await Promise.all(
    cadastros.map((id) =>
      listarNoIxc(credencial, {
        tabela: "fn_areceber",
        filtro: { campo: "fn_areceber.id_cliente", operador: "=", valor: id },
        tambem: [{ campo: "fn_areceber.status", operador: "=", valor: "A" }],
        campos: CAMPOS_DA_FATURA,
        limite: 50,
        ordenarPor: "fn_areceber.data_vencimento",
        ordem: "asc",
      }),
    ),
  );
  return recortarFaturas(listas.flatMap((l) => l.registros), hojeEmSaoPaulo(agora));
}

function financeiroDe(r: RecorteDeFaturas): FinanceiroParaAgente {
  const daVez = faturaDaVez([...r.vencidas, ...r.proximas]);
  const proxima = r.proximas[0];
  return {
    vencidas: r.vencidas.map(paraAgente),
    proxima: proxima ? paraAgente(proxima) : null,
    totalVencidoCents: r.totalVencidoCents,
    daVez: daVez ? paraAgente(daVez) : null,
  };
}

/**
 * A leitura do acesso PARA A IA — mais rígida que `resumo.situacao` (painel).
 * O painel, de propósito, assume "Liberado" quando nenhum contrato vigente
 * está na lista de bloqueados; aqui só se afirma "Liberado" quando o
 * vocabulário CONHECE o código como liberado (`acessoLiberado`). Um
 * `status_internet` que este conector nunca viu (upgrade do IXC, campo
 * customizado da instância…) não pode virar uma afirmação de "sem bloqueio"
 * pra quem não tem como conferir — vira `bloqueado: null` e o rótulo CRU do
 * código (`lerStatusDoAcesso` devolve o próprio código quando não reconhece).
 */
function situacaoParaAgente(vigentes: readonly ContratoIxc[]): { rotulo: string; detalhe: string | null; bloqueado: boolean | null } {
  if (vigentes.length === 0) return { rotulo: "Sem contrato ativo", detalhe: null, bloqueado: false };
  const bloqueado = vigentes.find((c) => c.bloqueado);
  if (bloqueado) return { rotulo: bloqueado.acesso.rotulo, detalhe: bloqueado.acesso.detalhe ?? null, bloqueado: true };
  const desconhecido = vigentes.find((c) => !acessoLiberado(c.statusInternet));
  if (desconhecido) return { rotulo: desconhecido.acesso.rotulo, detalhe: desconhecido.acesso.detalhe ?? null, bloqueado: null };
  return { rotulo: "Liberado", detalhe: null, bloqueado: false };
}

function clienteDe(resumo: ResumoIxc): ClienteParaAgente {
  const contratos = resumo.contratos.ok ? resumo.contratos.dados : null;
  const vigentes = contratos?.filter((c) => c.vigente) ?? [];
  const situacao = contratos ? situacaoParaAgente(vigentes) : null;
  const conexoes = resumo.conexoes.ok ? resumo.conexoes.dados : null;
  const os = resumo.ordensDeServico.ok ? resumo.ordensDeServico.dados : null;
  const nome = resumo.cliente.nome.trim();
  return {
    // Pessoa jurídica é tratada pelo nome inteiro: o "primeiro nome" de
    // "Mercado do Zé Ltda" seria "Mercado".
    primeiroNome: resumo.cliente.pessoaJuridica ? nome : (nome.split(/\s+/)[0] ?? ""),
    situacao: situacao?.rotulo ?? null,
    motivoDaSituacao: situacao?.detalhe ?? null,
    bloqueado: situacao?.bloqueado ?? null,
    plano: vigentes.map((c) => c.plano).filter(Boolean).join(" + ") || null,
    clienteDesde:
      vigentes
        .map((c) => c.ativadoEm.slice(0, 10))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()[0] ?? null,
    conexao:
      conexoes === null
        ? null
        : conexoes.some((c) => c.estado.tom === "bom")
          ? "online"
          : conexoes.some((c) => c.estado.tom === "ruim")
            ? "offline"
            : "sem_informacao",
    temOsAberta: os === null ? null : os.total > 0 || os.abertas.length > 0,
  };
}

/** `null` = o cadastro vinculado não existe mais no IXC. */
async function identificado(
  p: PedidoDeConsulta,
  cadastros: string[],
  vinculou: { verificadoPor: FormaDeVerificacao; cadastros: string[] } | null,
): Promise<ResultadoDaConsulta | null> {
  const [principal = ""] = cadastros;
  const [resumo, recorteDeTodos] = await Promise.all([
    montarResumo(p.credencial, principal, p.agora),
    cadastros.length > 1 ? recorteDe(p.credencial, cadastros, p.agora).catch(() => null) : Promise.resolve(undefined),
  ]);
  if (!resumo) return null;
  const recorte = recorteDeTodos === undefined ? (resumo.financeiro.ok ? resumo.financeiro.dados : null) : recorteDeTodos;
  return { estado: "identificado", cliente: clienteDe(resumo), financeiro: recorte ? financeiroDe(recorte) : null, vinculou };
}

async function vincularE(p: PedidoDeConsulta, cadastros: string[], verificadoPor: FormaDeVerificacao): Promise<ResultadoDaConsulta> {
  let criou = false;
  for (const externalId of cadastros) {
    // `vincular` devolve `{ vinculou, promovido }`: gravou agora OU promoveu a
    // linha que existia (o vínculo por telefone vira `documento` quando o CPF
    // confere). Os dois casos são "mudou o vínculo" e vão para a auditoria.
    const { vinculou } = await vincular({ admin: p.admin, orgId: p.orgId, contactId: p.contactId, conector: "ixc", externalId, verificadoPor, userId: null });
    criou = criou || vinculou;
  }
  return (await identificado(p, cadastros, criou ? { verificadoPor, cadastros } : null)) ?? { estado: "precisa_cpf_e_nascimento" };
}

async function consultar(p: PedidoDeConsulta): Promise<ResultadoDaConsulta> {
  const validos = await cadastrosValidos(p);
  if (validos.length > 0) {
    const r = await identificado(p, validos, null);
    if (r) return r;
    // O vínculo aponta para um cadastro que o IXC não devolve mais: identifica de novo.
  }

  // Conta antes de consulta: dígito verificador e calendário não revelam se o CPF é de alguém.
  const documento = p.cpfCnpj === undefined ? null : documentoNaMascara(p.cpfCnpj);
  if (p.cpfCnpj !== undefined && documento === null) return { estado: "cpf_invalido" };
  const nascimento = p.dataNascimento === undefined ? null : dataInformada(p.dataNascimento);
  if (p.dataNascimento !== undefined && nascimento === null) return { estado: "data_invalida" };

  // Procurar pelo telefone só onde ele prova quem é — fail-closed em "desconhecido".
  if (p.identidadeDoTelefone === "sim") {
    const candidatos = (await clientesPorTelefone(p.credencial, p.telefone)).slice(0, TETO_DE_CANDIDATOS);
    const [unico] = candidatos;
    if (candidatos.length === 1 && unico) {
      // O CPF, quando informado, tem de ser DESTE cadastro. Telefone reciclado
      // por operadora é comum, e vincular só porque o número bateu — com um CPF
      // que CONTRADIZ na mesma mensagem — identificaria a pessoa ERRADA (medido:
      // telefone da Maria + CPF de terceiro identificava a Maria, e a cobrança
      // dela sairia pro WhatsApp de outro). Contradição cai pro caminho de CPF +
      // nascimento, igual a quem não tem telefone nenhum batendo.
      const contradiz = documento !== null && soDigitos(unico.documento) !== soDigitos(documento);
      if (!contradiz) return vincularE(p, [unico.id], "telefone");
    }
    if (candidatos.length > 1) {
      if (!documento) return { estado: "precisa_cpf" };
      const doTitular = candidatos.filter((c) => soDigitos(c.documento) === soDigitos(documento));
      if (doTitular.length > 0) return vincularE(p, doTitular.map((c) => c.id), "documento");
      // O CPF não é de nenhum cadastro deste telefone: vale a regra de quem escreve de outro número.
    }
  }

  if (!documento || !nascimento) return { estado: "precisa_cpf_e_nascimento" };
  const { cadastros: conferidos, dataIlegivel } = await cadastrosQueConferem(p.credencial, documento, nascimento);
  if (conferidos.length === 0) return { estado: "nao_conferiu", ...(dataIlegivel ? { dataIlegivel: true } : {}) };
  return vincularE(p, conferidos.slice(0, TETO_DE_CANDIDATOS).map((c) => c.id), "documento");
}

const MOTIVOS_DE_PIX_QUE_O_BOLETO_SUPRE = new Set(["cobranca_indisponivel", "pix_inativo", "pix_corrompido"]);

function enviada(r: Extract<ResultadoDoEnvio, { ok: true }>, pixIndisponivel: boolean): ResultadoDaCobranca {
  return {
    resultado: "enviada",
    forma: r.forma,
    fatura: paraAgente(r.fatura),
    faturaId: r.fatura.id,
    enviadas: r.enviadas,
    previstas: r.previstas,
    pixGeradoAgora: r.pixGeradoAgora,
    pixIndisponivel,
  };
}

async function enviarCobranca(p: PedidoDeCobranca): Promise<ResultadoDaCobranca> {
  const cadastros = await cadastrosValidos(p);
  if (cadastros.length === 0) return { resultado: "cliente_nao_identificado" };

  const recorte = await recorteDe(p.credencial, cadastros, p.agora);
  // Valor ilegível vira 0 em `reaisParaCents`: cobrar R$ 0,00 é pior que não cobrar.
  const cobraveis = [...recorte.vencidas, ...recorte.proximas].filter((f) => f.valorCents > 0);
  const daVez = faturaDaVez(cobraveis);
  if (!daVez) return { resultado: "sem_fatura_em_aberto" };
  const base = { fatura: paraAgente(daVez), faturaId: daVez.id };
  // D5: acima do limite, a fatura é da Cobrança — nada sai.
  if (daVez.diasDeAtraso > p.limiteDeDias) return { resultado: "encaminhar_para_cobranca", ...base };

  const pedir = (forma: "pix" | "boleto") =>
    enviarCobrancaIxc({
      credencial: p.credencial,
      cadastrosVinculados: new Set(cadastros),
      faturaId: daVez.id,
      forma,
      portas: p.portas,
      ...(p.agora ? { agora: p.agora } : {}),
    });

  if (p.forma === "boleto") {
    const boleto = await pedir("boleto");
    if (boleto.ok) return enviada(boleto, false);
    // O cliente ESCOLHEU boleto: trocar pelo Pix sem perguntar desfaria a escolha dele.
    if (boleto.motivo === "forma_indisponivel") return { resultado: "boleto_indisponivel", ...base };
    return { resultado: "sem_como_cobrar", ...base, ...(boleto.detalheDoErp ? { detalheDoErp: boleto.detalheDoErp } : {}) };
  }

  const pix = await pedir("pix");
  if (pix.ok) return enviada(pix, false);
  // D3 + D6: o Pix falhou; se o boleto já está registrado, ele sai no lugar — só
  // as DUAS formas falhando é que mandam a conversa para a Cobrança.
  if (daVez.temBoleto && MOTIVOS_DE_PIX_QUE_O_BOLETO_SUPRE.has(pix.motivo)) {
    const boleto = await pedir("boleto");
    if (boleto.ok) return enviada(boleto, true);
  }
  return { resultado: "sem_como_cobrar", ...base, ...(pix.detalheDoErp ? { detalheDoErp: pix.detalheDoErp } : {}) };
}

export const agenteIxc: CapacidadeDoAgente = { consultar, enviarCobranca };
