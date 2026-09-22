/**
 * ENVIAR A COBRANÇA DE UMA FATURA — boleto em PDF ou Pix — numa conversa.
 *
 * UMA função, dois chamadores: hoje o botão do atendente
 * (`POST …/ixc/faturas/[id]/enviar`); amanhã a ferramenta da IA. É por isso que
 * ela mora aqui, sem HTTP e sem sessão: quem chama resolve QUEM é o ator e QUAL
 * é a conversa, e entrega duas portas — guardar um arquivo e enviar uma
 * mensagem. O que esta função garante vale para os dois, e é o que não pode
 * depender de quem pede:
 *
 *   1. a fatura é RELIDA no IXC, e tem de ser de um cadastro vinculado ao
 *      contato — senão a cobrança de um cliente iria para o WhatsApp de outro;
 *   2. ainda está em aberto (o cliente pode ter pago um minuto atrás);
 *   3. o BOLETO só é pedido quando o IXC já o registrou (sem registro não há
 *      PDF, e pedir faria o IXC registrar um boleto que ninguém pediu). O PIX é
 *      diferente: o IXC o gera SOB DEMANDA, então escolher Pix É pedir que ele
 *      seja gerado — e o resultado diz se foi gerado agora, para a auditoria;
 *   4. o que sai foi conferido: o PDF começa com `%PDF`, o copia-e-cola fecha o
 *      CRC, o Pix está ATIVO. Nenhum número é digitado por ninguém.
 *
 * Cada cobrança são DUAS mensagens: o arquivo com a legenda, e o código sozinho
 * (linha digitável ou copia-e-cola), para copiar com um toque.
 */
import type { ArquivoDaCobranca, CredencialDeConector, MensagemDaCobranca, PortasDoEnvio } from "../tipos";
import { CAMPOS_DA_FATURA } from "./campos";
import { hojeEmSaoPaulo, lerFatura, reaisParaCents, type Fatura, type FormaDeCobranca } from "./faturas";
import { baixarBoletoDoIxc, buscarPixNoIxc, listarNoIxc } from "./http";
import { legendaDoBoleto, legendaDoPix, nomeDoArquivo } from "./mensagem-fatura";
import { copiaEColaIntegro, qrCodeDoPix } from "./pix";

// Os tipos das portas moram no contrato: o motor preenche as mesmas portas sem conhecer o IXC.
export type { ArquivoDaCobranca, MensagemDaCobranca, PortasDoEnvio };

export type MotivoDaRecusa =
  | "fatura_nao_encontrada"
  | "fatura_fechada"
  | "forma_indisponivel"
  | "cobranca_indisponivel"
  | "pix_inativo"
  | "pix_corrompido";

export type ResultadoDoEnvio =
  | {
      ok: true;
      forma: FormaDeCobranca;
      fatura: Fatura;
      enviadas: number;
      previstas: number;
      /** O Pix não existia e o IXC o gerou por causa DESTE pedido — vai para a auditoria. */
      pixGeradoAgora: boolean;
    }
  /** `detalheDoErp`: a frase do próprio IXC, quando ele disse por que não devolveu. */
  | { ok: false; motivo: MotivoDaRecusa; detalheDoErp?: string };

export interface PedidoDeEnvio {
  credencial: CredencialDeConector;
  /** Os cadastros do IXC vinculados a ESTE contato. A fatura tem de ser de um deles. */
  cadastrosVinculados: ReadonlySet<string>;
  faturaId: string;
  forma: FormaDeCobranca;
  portas: PortasDoEnvio;
  agora?: Date;
}

export async function enviarCobrancaIxc(p: PedidoDeEnvio): Promise<ResultadoDoEnvio> {
  const { registros } = await listarNoIxc(p.credencial, {
    tabela: "fn_areceber",
    filtro: { campo: "fn_areceber.id", operador: "=", valor: p.faturaId },
    campos: CAMPOS_DA_FATURA,
    limite: 1,
  });
  const registro = registros.find((r) => r.id === p.faturaId);
  // A MESMA resposta para "não existe" e "é de outro cliente": dizer qual dos
  // dois seria confirmar a um curioso que o id é de alguém.
  if (!registro || !p.cadastrosVinculados.has(registro.id_cliente ?? "")) {
    return { ok: false, motivo: "fatura_nao_encontrada" };
  }
  if (registro.status !== "A") return { ok: false, motivo: "fatura_fechada" };

  const fatura = lerFatura(registro, hojeEmSaoPaulo(p.agora));
  if (!fatura) return { ok: false, motivo: "fatura_nao_encontrada" };
  if (p.forma === "boleto" && !fatura.temBoleto) return { ok: false, motivo: "forma_indisponivel" };

  let arquivo: ArquivoDaCobranca;
  let legenda: string;
  let codigo: string;

  if (p.forma === "boleto") {
    const pdf = await baixarBoletoDoIxc(p.credencial, fatura.id);
    if (!pdf) return { ok: false, motivo: "cobranca_indisponivel" };
    arquivo = { nome: nomeDoArquivo("boleto", fatura), extensao: "pdf", mime: "application/pdf", conteudo: pdf };
    legenda = legendaDoBoleto(fatura);
    codigo = fatura.linhaDigitavel;
  } else {
    const resposta = await buscarPixNoIxc(p.credencial, fatura.id);
    if (!resposta.ok) {
      return { ok: false, motivo: "cobranca_indisponivel", ...(resposta.mensagemDoIxc ? { detalheDoErp: resposta.mensagemDoIxc } : {}) };
    }
    const { pix } = resposta;
    // Pix pago, expirado ou removido ainda volta na consulta — com outro status.
    // Mandar um QR que o banco vai recusar é pior que dizer que não deu.
    if (pix.status !== "ATIVA") return { ok: false, motivo: "pix_inativo" };
    if (!copiaEColaIntegro(pix.copiaECola)) return { ok: false, motivo: "pix_corrompido" };
    const valorDoPix = reaisParaCents(pix.valorOriginal);
    arquivo = {
      nome: nomeDoArquivo("pix", fatura),
      extensao: "png",
      mime: "image/png",
      conteudo: await qrCodeDoPix(pix.copiaECola),
    };
    legenda = legendaDoPix(fatura, valorDoPix > 0 ? valorDoPix : fatura.valorCents);
    codigo = pix.copiaECola;
  }

  const caminho = await p.portas.guardarArquivo(arquivo);
  const mensagens: MensagemDaCobranca[] = [
    {
      type: p.forma === "boleto" ? "document" : "image",
      body: legenda,
      media_storage_path: caminho,
      media_mime: arquivo.mime,
      media_size_bytes: arquivo.conteudo.length,
    },
    ...(codigo ? [{ type: "text" as const, body: codigo }] : []),
  ];

  let enviadas = 0;
  try {
    for (const mensagem of mensagens) {
      await p.portas.enviar(mensagem);
      enviadas += 1;
    }
  } catch (err) {
    // Nada saiu: o erro é de quem chama (a rota responde com ele). Saiu o arquivo
    // e o código não: devolve a contagem — a tela avisa, e o audit registra.
    if (enviadas === 0) throw err;
  }
  return {
    ok: true,
    forma: p.forma,
    fatura,
    enviadas,
    previstas: mensagens.length,
    pixGeradoAgora: p.forma === "pix" && !fatura.pixJaGerado,
  };
}
