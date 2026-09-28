/**
 * O ramal do navegador (spec 20 §4.1): credencial temporária do atendente,
 * emitida pelo CRM e empurrada para a memória do Asterisk.
 *
 * Temporária no sentido que importa: não existe em disco nem no banco, e some
 * quando o Asterisk reinicia — o navegador recebe 401 no próximo registro e
 * pede outra. Estável entre abas: se o ramal já existe, a mesma senha é
 * devolvida, para que duas abas do mesmo atendente não fiquem trocando a senha
 * uma da outra a cada renovação.
 *
 * O que a senha NÃO dá: discar. O contexto do ramal só entrega ao Stasis, e o
 * controlador só liga para fora com um pedido criado pela API para esta pessoa.
 */
import { randomBytes } from "node:crypto";

import { ErroAri, type ClienteAri } from "./ari";
import { ORDEM_DE_GRAVACAO, idDoRamal, objetosDoRamal } from "./pjsip";

export interface CredencialDoRamal {
  usuario: string;
  senha: string;
}

async function senhaExistente(ari: ClienteAri, id: string): Promise<string | null> {
  try {
    const campos = await ari.pedir<Array<{ attribute: string; value: string }>>(
      "GET",
      `/asterisk/config/dynamic/res_pjsip/auth/${encodeURIComponent(id)}`,
    );
    const senha = campos.find((c) => c.attribute === "password")?.value;
    return senha && senha.length >= 24 ? senha : null;
  } catch (e) {
    if (e instanceof ErroAri && e.status === 404) return null;
    throw e;
  }
}

export async function credencialDoRamal(ari: ClienteAri, userId: string, nome: string): Promise<CredencialDoRamal> {
  const usuario = idDoRamal(userId);
  const existente = await senhaExistente(ari, usuario);
  // Já existe: devolve a mesma e não regrava nada. Regravar a AOR de um ramal
  // registrado arrisca derrubar o registro da outra aba no meio de uma ligação.
  if (existente) return { usuario, senha: existente };
  const senha = randomBytes(24).toString("base64url");
  const objetos = objetosDoRamal({ userId, senha, nome });
  for (const tipo of ORDEM_DE_GRAVACAO) {
    for (const o of objetos.filter((x) => x.tipo === tipo)) await ari.gravarObjeto(o.tipo, o.id, o.campos);
  }
  return { usuario, senha };
}
