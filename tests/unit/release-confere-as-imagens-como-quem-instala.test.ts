import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A CONFERÊNCIA DO FIM DA RELEASE PERGUNTA AO REGISTRO COMO QUEM INSTALA.
 *
 * ═══ O que este arquivo guarda ══════════════════════════════════════════════
 *
 * Depois de criar a tag, o `cortar-tag` espera as imagens e confere que elas
 * existem — a falha dessa cadeia é silenciosa por natureza, e o workflow prova
 * a consequência em vez de supô-la. A sonda nasceu ANÔNIMA de propósito: com o
 * repositório público, quem instala não tem credencial nossa, e um pacote que
 * ficou privado por engano tem de reprovar.
 *
 * Com o repositório FECHADO a pergunta muda de dono. As imagens são privadas de
 * propósito, todo mundo que instala tem login, e a sonda anônima responderia
 * "não existe" para sempre — cada release esperaria 30 minutos (faturados) para
 * reprovar uma versão que saiu inteira.
 *
 * E há um segundo defeito, que só existe no mundo fechado: fechar o repositório
 * NÃO fecha os pacotes. A visibilidade de cada um muda só pela tela do GitHub, e
 * a imagem do worker carrega o código inteiro (`COPY . .`). Repositório privado
 * com pacote público expõe tudo, e nada mais no projeto olha para isso.
 *
 * ═══ Por que este teste EXECUTA o bash do workflow ══════════════════════════
 *
 * Pela mesma razão de `guarda-da-release-reconhece-o-corte.test.ts`: reescrever
 * a regra em TypeScript criaria uma segunda verdade que envelhece sozinha. O
 * bloco `run:` é extraído do `release.yml` e executado contra um registro de
 * mentira — o que está sob teste é o arquivo que o CI usa.
 *
 * O registro de mentira responde como o GHCR: o endpoint de token devolve um
 * token diferente para quem mandou credencial, e o de manifesto só entrega o
 * digest a quem tem direito. A visibilidade dos pacotes é escolhida por caso.
 */

const RAIZ = process.cwd();
const YML = readFileSync(join(RAIZ, ".github/workflows/release.yml"), "utf8");
const NOME_DO_PASSO = "As três imagens existem nesta versão?";
const SEGREDO = "segredo-de-teste-que-nao-pode-vazar";

/** O bloco `run:` do passo, sem o recuo do YAML. */
function bashDaConferencia(): string {
  const inicio = YML.indexOf(`- name: ${NOME_DO_PASSO}`);
  expect(inicio, "o passo da conferência sumiu do release.yml").toBeGreaterThan(-1);
  const run = YML.indexOf("run: |", inicio);
  expect(run, "o passo da conferência não tem bloco run").toBeGreaterThan(-1);

  const corpo: string[] = [];
  for (const l of YML.slice(run + "run: |".length).split("\n").slice(1)) {
    // O bloco vai até a primeira linha não-vazia com recuo menor que o dele.
    if (l.trim() !== "" && !l.startsWith("          ")) break;
    corpo.push(l.slice(10));
  }
  return corpo.join("\n");
}

/** O trecho do job `cortar-tag`, do nome dele até o fim do arquivo (é o último). */
function jobCortarTag(): string {
  const i = YML.indexOf("\n  cortar-tag:\n");
  expect(i, "o job cortar-tag sumiu").toBeGreaterThan(-1);
  return YML.slice(i);
}

let dir: string;
let logDoCurl: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "conferencia-release-"));
  logDoCurl = join(dir, "curl.log");

  // O registro de mentira. `PACOTES` = publico|privado; `LOGIN_VE` = sim|nao.
  writeFileSync(
    join(dir, "curl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CURL_LOG"
args=" $* "
case "$args" in
  *ghcr.io/token*)
    case "$args" in
      *" -K - "*)
        # Só lê o stdin quando a credencial vem por ele.
        if grep -q '^user = "'; then printf '{"token":"com-login"}'; else printf '{"token":"anonimo"}'; fi ;;
      *) printf '{"token":"anonimo"}' ;;
    esac ;;
  *ghcr.io/v2/*)
    ve=nao
    case "$args" in
      *"Bearer com-login"*) [ "\${LOGIN_VE:-sim}" = sim ] && ve=sim ;;
      *"Bearer anonimo"*)   [ "\${PACOTES:-publico}" = publico ] && ve=sim ;;
    esac
    if [ "$ve" = sim ]; then
      img="\${args##*/v2/dono/}"; img="\${img%%/manifests/*}"
      printf 'HTTP/2 200\\r\\nDocker-Content-Digest: sha256:%s\\r\\n\\r\\n' "$img"
    else
      printf 'HTTP/2 401\\r\\n\\r\\n'
    fi ;;
esac
exit 0
`,
  );
  // A espera pela publicação é um laço de `sleep 30`. Aqui o tempo não passa.
  writeFileSync(join(dir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(dir, "curl"), 0o755);
  chmodSync(join(dir, "sleep"), 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Cenario {
  repoPrivado: boolean;
  pacotes: "publico" | "privado";
  loginVe?: "sim" | "nao";
}

function conferir(c: Cenario): { status: number; saida: string; chamadas: string } {
  writeFileSync(logDoCurl, "");
  const r = spawnSync("bash", ["-c", bashDaConferencia()], {
    encoding: "utf8",
    env: {
      // O ambiente de quem roda vem junto (o tipo de `ProcessEnv` deste projeto
      // exige `NODE_ENV`), e TUDO que o script lê é sobrescrito logo abaixo —
      // inclusive `GITHUB_ACTOR` e `GITHUB_REPOSITORY_OWNER`, que o runner do CI
      // define de verdade.
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      CURL_LOG: logDoCurl,
      VERSAO: "9.9.9",
      REPO_PRIVADO: String(c.repoPrivado),
      GHCR_LEITURA: SEGREDO,
      GITHUB_REPOSITORY_OWNER: "dono",
      GITHUB_ACTOR: "ator",
      PACOTES: c.pacotes,
      LOGIN_VE: c.loginVe ?? "sim",
    },
  });
  return {
    status: r.status ?? -1,
    saida: `${r.stdout}\n${r.stderr}`,
    chamadas: readFileSync(logDoCurl, "utf8"),
  };
}

describe("a conferência do fim da release pergunta ao registro como quem instala", () => {
  it("o instrumento está vivo: o bloco extraído é a conferência, e o registro de mentira responde", () => {
    const script = bashDaConferencia();
    expect(script).toContain("ghcr_digest");
    expect(script).toContain("docker-content-digest");
    // Controle dos casos seguintes: o mesmo script, no cenário de hoje, PASSA.
    const r = conferir({ repoPrivado: false, pacotes: "publico" });
    expect(r.status, r.saida).toBe(0);
    expect(r.chamadas).toContain("ghcr.io/v2/dono/deskcommcrm/manifests/9.9.9");
  });

  it("repositório público: pergunta como ANÔNIMO — é quem instala sem credencial nossa", () => {
    const r = conferir({ repoPrivado: false, pacotes: "publico" });
    expect(r.status, r.saida).toBe(0);
    expect(r.saida).toContain("como anônimo");
    expect(r.saida).toContain("stable e 9.9.9 são o mesmo manifesto");
  });

  it("repositório público com pacote PRIVADO continua reprovando — a armadilha do pacote que nasce privado", () => {
    // É a razão de a sonda ter nascido anônima. Se o modo com login valesse
    // também aqui, um pacote esquecido como privado passaria verde e nenhuma
    // instalação pública conseguiria puxar a versão.
    const r = conferir({ repoPrivado: false, pacotes: "privado" });
    expect(r.status, r.saida).toBe(1);
    expect(r.saida).toContain("as imagens não apareceram");
    expect(r.saida, "não disse a causa provável").toContain("PRIVADAS com o repositório ainda público");
  });

  it("repositório PRIVADO com pacotes privados: pergunta com login, e passa", () => {
    const r = conferir({ repoPrivado: true, pacotes: "privado" });
    expect(r.status, r.saida).toBe(0);
    expect(r.saida).toContain("com login");
    expect(r.saida).toContain("stable e 9.9.9 são o mesmo manifesto");
    expect(r.saida).toContain("nenhuma das quatro imagens baixa sem login");
  });

  it("repositório PRIVADO com pacote PÚBLICO reprova ALTO — o código está exposto pela imagem", () => {
    const r = conferir({ repoPrivado: true, pacotes: "publico" });
    expect(r.status, "pacote público com repositório privado tem de reprovar").toBe(1);
    expect(r.saida).toContain("baixam SEM login");
    // As QUATRO: o worker é o que carrega o código, mas o esquecimento é por pacote.
    for (const img of ["deskcommcrm", "deskcomm-worker", "deskcomm-scheduler", "deskcomm-asterisk"]) {
      expect(r.saida, `a guarda não olhou ${img}`).toContain(img);
    }
    expect(r.saida).toContain("docs/runbooks/repositorio-fechado.md");
  });

  it("com o repositório público, a sonda COM login roda como informação — e nunca reprova", () => {
    // Ela existe para o caminho com login ser exercitado em toda release ANTES
    // do dia de fechar. Se reprovasse, uma release que saiu inteira ficaria
    // vermelha por causa de uma sonda que ainda não decide nada.
    const ok = conferir({ repoPrivado: false, pacotes: "publico" });
    expect(ok.saida).toContain("[informação]");
    expect(ok.chamadas, "a sonda com login não chegou a rodar").toContain("-K -");

    const cega = conferir({ repoPrivado: false, pacotes: "publico", loginVe: "nao" });
    expect(cega.status, cega.saida).toBe(0);
    expect(cega.saida, "sonda com login cega tem de AVISAR").toContain("::warning::");
  });

  it("a credencial nunca aparece na linha de comando do curl", () => {
    // Na linha de comando ela ficaria visível em `ps` e no log de quem depura
    // com `set -x`. Vai por stdin (`-K -`).
    for (const c of [
      { repoPrivado: true, pacotes: "privado" } as const,
      { repoPrivado: false, pacotes: "publico" } as const,
    ]) {
      const r = conferir(c);
      expect(r.chamadas, "fixture: a sonda com login não rodou").toContain("-K -");
      expect(r.chamadas).not.toContain(SEGREDO);
      expect(r.saida).not.toContain(SEGREDO);
    }
  });
});

describe("o modo da conferência sai da visibilidade do repositório, e o token só LÊ", () => {
  it("o passo recebe a visibilidade do repositório — não uma variável para alguém lembrar de ligar", () => {
    const passo = jobCortarTag().slice(jobCortarTag().indexOf(`- name: ${NOME_DO_PASSO}`));
    expect(passo).toMatch(/REPO_PRIVADO:\s*\$\{\{\s*github\.event\.repository\.private\s*\}\}/);
  });

  it("o job pede LEITURA de pacotes, e nenhuma escrita", () => {
    const job = jobCortarTag();
    expect(job, "sem `packages: read` a sonda com login é recusada pelo registro").toMatch(
      /^ {6}packages:\s*read\s*$/m,
    );
    expect(
      job.split("\n").filter((l) => /^\s+[a-z-]+:\s*write\s*$/.test(l)),
      "escrita pelo GITHUB_TOKEN no job que corta a tag: quem escreve é o App",
    ).toEqual([]);
  });
});
