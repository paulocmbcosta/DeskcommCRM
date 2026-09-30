/**
 * O NAVEGADOR SÓ TOCA SE CONSEGUIR LER A INVITE — e quem decide isso é o
 * hostname do contêiner do Asterisk.
 *
 * O PJSIP põe o hostname da máquina no From e no Contact das INVITEs que manda
 * aos ramais (os navegadores, via WebSocket). Sem `hostname:` no compose, esse
 * nome é o id aleatório do contêiner — hexadecimal, sorteado a cada recriação.
 * Quando o sorteio começa por DÍGITO, o JsSIP recusa o cabeçalho From (a
 * gramática do RFC 3261 exige letra no início do último rótulo do host) e
 * descarta a mensagem inteira em silêncio: sem 100, sem 180, sem aviso. O ramal
 * continua registrado e a ligação fica chamando ninguém.
 *
 * Medido em 30/09/2026: o deploy da 1.51.0 recriou o Asterisk como
 * `39779767aa76` e, dali em diante, nenhuma ligação recebida tocou em navegador
 * nenhum. As feitas seguiam funcionando (a resposta usa o IP do transporte).
 *
 * O teste usa o PRÓPRIO leitor do JsSIP — o que roda no navegador —, não uma
 * regex que imita a gramática: se o JsSIP mudar a regra, este teste acompanha.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const Parser = require("jssip/lib/Parser.js") as {
  parseMessage: (data: string, ua: unknown) => { method?: string; from?: { uri: { host: string } } } | undefined;
};

const ler = (arquivo: string) => readFileSync(join(process.cwd(), arquivo), "utf8");

/** O bloco de um serviço do compose, sem comentários (o molde é portas-do-compose.test.ts). */
function blocoDoServico(texto: string, nome: string): string | null {
  const todas = texto.split("\n");
  const inicio = todas.findIndex((l) => /^services:\s*$/.test(l));
  if (inicio === -1) throw new Error("bloco services: não encontrado no compose");
  let dentro = false;
  const buffer: string[] = [];
  for (const l of todas.slice(inicio + 1)) {
    if (/^\S/.test(l)) break;
    const cabecalho = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(l);
    if (cabecalho) {
      if (dentro) break;
      dentro = cabecalho[1] === nome;
      continue;
    }
    if (dentro && !/^\s*#/.test(l)) buffer.push(l);
  }
  return dentro ? buffer.join("\n") : null;
}

function hostnameDoAsterisk(arquivo: string): string | null {
  const bloco = blocoDoServico(ler(arquivo), "asterisk");
  if (bloco === null) return null;
  const m = /^ {4}hostname:\s*"?([^"\s#]+)"?\s*$/m.exec(bloco);
  return m ? m[1]! : null;
}

/** A INVITE que o Asterisk manda ao ramal, no formato medido na produção (dados de exemplo). */
function inviteDoAsterisk(host: string): string {
  const sdp = ["v=0", "o=- 1 1 IN IP4 172.19.0.6", "s=Asterisk", "c=IN IP4 172.19.0.6", "t=0 0", "m=audio 20022 UDP/TLS/RTP/SAVPF 0 8 101", ""].join("\r\n");
  return [
    "INVITE sip:abcdefgh@172.19.0.8:45474;transport=ws SIP/2.0",
    "Via: SIP/2.0/WS 172.19.0.6:8088;rport;branch=z9hG4bKPjexemplo;alias",
    `From: <sip:+5561900000000@${host}>;tag=exemplo`,
    "To: <sip:abcdefgh@172.19.0.8>",
    `Contact: <sip:asterisk@${host}:5060;transport=ws>`,
    "Call-ID: exemplo-call-id",
    "CSeq: 1 INVITE",
    "Max-Forwards: 70",
    "Content-Type: application/sdp",
    `Content-Length: ${sdp.length}`,
    "",
    sdp,
  ].join("\r\n");
}

const lidaPeloNavegador = (host: string) => Parser.parseMessage(inviteDoAsterisk(host), { configuration: {} });

describe("hostname do Asterisk × leitor SIP do navegador (JsSIP)", () => {
  it("controle: com o hostname sorteado pelo Docker que derrubou a produção, o JsSIP descarta a INVITE", () => {
    expect(lidaPeloNavegador("39779767aa76")).toBeUndefined();
  });

  it("controle: com um id sorteado que começa por letra, lê — por isso o defeito ia e voltava a cada deploy", () => {
    expect(lidaPeloNavegador("f3a9c0d1b2e4")?.method).toBe("INVITE");
  });

  it("o serviço asterisk do compose de produção fixa o hostname", () => {
    expect(hostnameDoAsterisk("docker-compose.prod.yml")).not.toBeNull();
  });

  it("com o hostname do compose, o JsSIP lê a INVITE e o host chega intacto", () => {
    const host = hostnameDoAsterisk("docker-compose.prod.yml")!;
    const lida = lidaPeloNavegador(host);
    expect(lida?.method).toBe("INVITE");
    expect(lida?.from?.uri.host).toBe(host);
  });

  it("o override do Traefik não troca o hostname por outro", () => {
    const doTraefik = hostnameDoAsterisk("docker-compose.traefik.yml");
    if (doTraefik !== null) expect(lidaPeloNavegador(doTraefik)?.method).toBe("INVITE");
  });
});
