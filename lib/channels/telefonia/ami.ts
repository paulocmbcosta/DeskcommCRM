/**
 * Leitura do estado dos registros de tronco pela AMI — a única coisa que o CRM
 * pede à AMI. A ARI diz se a operadora RESPONDE (qualify), mas não se ela
 * ACEITOU a senha; a tela precisa dizer "senha recusada", e isso só a AMI sabe.
 *
 * Conexão curta por consulta (login → ação → logoff): o worker pergunta a cada
 * poucos segundos, e uma conexão longa seria mais um laço a reconectar.
 */
import { createConnection } from "node:net";

import { USUARIO_ARI } from "./ari";

export type EstadoDoRegistro = "Registered" | "Unregistered" | "Rejected" | "Stopped" | string;

export interface RegistroDoTronco {
  /** Nome do objeto de registro (`tronco-<id>`). */
  objeto: string;
  estado: EstadoDoRegistro;
}

function blocos(texto: string): Array<Record<string, string>> {
  return texto
    .split("\r\n\r\n")
    .map((b) => {
      const campos: Record<string, string> = {};
      for (const linha of b.split("\r\n")) {
        const i = linha.indexOf(": ");
        if (i > 0) campos[linha.slice(0, i)] = linha.slice(i + 2);
      }
      return campos;
    })
    .filter((c) => Object.keys(c).length > 0);
}

export function lerRegistros(p: { host: string; porta?: number; senha: string; prazoMs?: number }): Promise<RegistroDoTronco[]> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: p.host, port: p.porta ?? 5038 });
    let buffer = "";
    let fim = false;
    const terminar = (erro: Error | null, valor?: RegistroDoTronco[]) => {
      if (fim) return;
      fim = true;
      clearTimeout(prazo);
      sock.destroy();
      if (erro) reject(erro);
      else resolve(valor ?? []);
    };
    const prazo = setTimeout(() => terminar(new Error("ami: sem resposta no prazo")), p.prazoMs ?? 5_000);

    sock.setEncoding("utf8");
    sock.on("error", (e) => terminar(e));
    sock.on("close", () => terminar(new Error("ami: conexão fechada antes da resposta")));
    sock.on("connect", () => {
      sock.write(
        `Action: Login\r\nUsername: ${USUARIO_ARI}\r\nSecret: ${p.senha}\r\nEvents: off\r\nActionID: login\r\n\r\n` +
          `Action: PJSIPShowRegistrationsOutbound\r\nActionID: regs\r\n\r\n`,
      );
    });
    sock.on("data", (parte: string) => {
      buffer += parte;
      const todos = blocos(buffer);
      const login = todos.find((b) => b.ActionID === "login");
      if (login && login.Response === "Error") return terminar(new Error(`ami: login recusado (${login.Message ?? ""})`));
      const doRegs = todos.filter((b) => b.ActionID === "regs");
      const erro = doRegs.find((b) => b.Response === "Error");
      // "No objects found" é a resposta de quem não tem tronco nenhum: lista vazia.
      if (erro) return terminar(null, []);
      if (doRegs.some((b) => b.Event === "OutboundRegistrationDetailComplete")) {
        sock.write("Action: Logoff\r\n\r\n");
        terminar(
          null,
          doRegs
            .filter((b) => b.Event === "OutboundRegistrationDetail" && b.ObjectName)
            .map((b) => ({ objeto: b.ObjectName!, estado: b.Status ?? "Unregistered" })),
        );
      }
    });
  });
}
