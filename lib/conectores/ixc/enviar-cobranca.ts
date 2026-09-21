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
 *   3. a forma pedida EXISTE para ela (boleto registrado / Pix gerado) — pedir
 *      ao IXC o que não existe faria ele registrar a cobrança, efeito que
 *      ninguém pediu;
 *   4. o que sai foi conferido: o PDF começa com `%PDF`, o copia-e-cola fecha o
 *      CRC, o Pix está ATIVO. Nenhum número é digitado por ninguém.
 *
 * Cada cobrança são DUAS mensagens: o arquivo com a legenda, e o código sozinho
 * (linha digitável ou copia-e-cola), para copiar com um toque.
 */
import type { CredencialDeConector } from "../tipos";
import { CAMPOS_DA_FATURA } from "./campos";
import { hojeEmSaoPaulo, lerFatura, reaisParaCents, type Fatura, type FormaDeCobranca } from "./faturas";
import { baixarBoletoDoIxc, buscarPixNoIxc, listarNoIxc } from "./http";
import { legendaDoBoleto, legendaDoPix, nomeDoArquivo } from "./mensagem-fatura";
import { copiaEColaIntegro, qrCodeDoPix } from "./pix";

export interface ArquivoDaCobranca {
  /** Sem extensão e sem caminho: `boleto-10-09-2026`. Quem guarda decide onde. */
  nome: string;
  extensao: "pdf" | "png";
  mime: "application/pdf" | "image/png";
  conteudo: Buffer;
}

export interface MensagemDaCobranca {
  type: "text" | "document" | "image";
  body: string;
  media_storage_path?: string;
  media_mime?: string;
  media_size_bytes?: number;
}

export interface PortasDoEnvio {
  /** Sobe o arquivo (storage-first) e devolve o caminho que `enviar` vai citar. */
  guardarArquivo(arquivo: ArquivoDaCobranca): Promise<string>;
  /** Envia UMA mensagem na conversa — a saída de sempre: fila, anti-banimento, opt-out. */
  enviar(mensagem: MensagemDaCobranca): Promise<void>;
}

export type MotivoDaRecusa =
  | "fatura_nao_encontrada"
  | "fatura_fechada"
  | "forma_indisponivel"
  | "cobranca_indisponivel"
  | "pix_inativo"
  | "pix_corrompido";

export type ResultadoDoEnvio =
  | { ok: true; forma: FormaDeCobranca; fatura: Fatura; enviadas: number; previstas: number }
  | { ok: false; motivo: MotivoDaRecusa };

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
  if (p.forma === "boleto" ? !fatura.temBoleto : !fatura.temPix) return { ok: false, motivo: "forma_indisponivel" };

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
    const pix = await buscarPixNoIxc(p.credencial, fatura.id);
    if (!pix) return { ok: false, motivo: "cobranca_indisponivel" };
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
  return { ok: true, forma: p.forma, fatura, enviadas, previstas: mensagens.length };
}
