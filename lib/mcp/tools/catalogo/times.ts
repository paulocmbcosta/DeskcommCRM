/**
 * Capacidade de TIMES — os setores que recebem conversa.
 *
 * Domínio próprio, e não uma sétima entrada em `escalacao.ts`, por dois motivos:
 * o handler mora em `lib/mcp/tools/times.ts` (um arquivo de catálogo por domínio
 * é a convenção desta pasta), e o cabeçalho de `escalacao.ts` afirma "as seis
 * capacidades" — afirmação que uma sétima linha tornaria falsa em silêncio.
 *
 * ESTE ARQUIVO FALA COM O HUMANO que configura o agente. O texto que vai ao
 * MODELO é a `description` do handler, e não tem cópia aqui.
 */
import { declararTools } from "./tipos";

export const TOOLS_TIMES = declararTools([
  {
    name: "crm_list_teams",
    category: "read",
    rotulo: "Ver os setores que atendem",
    explicacao:
      "Mostra quais setores de atendimento a empresa tem, para que serve cada um, se estão dentro do horário agora e quantas pessoas podem assumir.",
    oQueToca: "Setores de atendimento",
    risco: "seguro",
    pacotes: ["escalar"],
  },
]);
