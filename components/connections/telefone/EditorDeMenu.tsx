"use client";
/**
 * O editor de UM menu de voz da aba Menus (Conexões › Telefone) — novo ou
 * existente. Desenho da fase 2, §6.2 e D15.
 *
 * A FALA ACOMPANHA AS OPÇÕES. Enquanto ninguém a escreve à mão, ela é o texto
 * montado das opções (`montarTextoDoMenu`, no idioma de quem monta): trocar o time
 * de uma tecla, acrescentar ou tirar uma opção muda a fala, e o "Salvar menu" pede
 * a prévia do texto novo — a URA nunca diz "Para Suporte, digite 1" mandando para
 * o Financeiro. Um menu salvo abre assim quando a fala dele É o texto montado das
 * opções dele; se a fala salva é outra, ela foi escrita à mão, e o campo a
 * mantém. Fala escrita à mão não muda sozinha: quando as opções mudam depois
 * dela, a tela AVISA que ela pode não bater mais e oferece "Usar o texto montado".
 *
 * O "Salvar menu" só aceita a prévia do texto que está no campo, ou a fala em uso
 * se o texto não mudou (`falaParaSalvar`). O porquê de ele estar travado vem de
 * `oQueFaltaNoMenu` (lib/telefonia/falta-no-menu.ts) e é a descrição acessível do
 * botão.
 *
 * Recusas da rota aparecem com a frase DELA (`fraseDaFalhaDaFala`), ao lado da
 * fala que a rota aponta (`details.fala`). Com `previa_ausente`, a fala em uso
 * deixa de valer: sai do "nada mudou", o selo deixa de dizer "Em uso" e o tocador
 * dela some, até a prévia nova — senão o botão convidaria à mesma recusa.
 *
 * Um gesto por vez: enquanto salva, os campos e "Gerar prévia" travam; enquanto
 * uma prévia é gerada, "Salvar menu" trava. Os ids dos campos são FIXOS
 * (`menu-nome`, `menu-padrao`, `menu-texto`, `menu-invalida`): a prova pela tela
 * (tests/e2e) os procura, e só um editor fica aberto por vez. Ao abrir, o foco vai
 * para o nome; quem devolve o foco ao fechar é a lista (MenusDoTelefone).
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { falaParaSalvar, fraseDaFalhaDaFala, usePreviaDaFala } from "@/components/telefonia/usePreviaDaFala";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import type { TimeDoInbox } from "@/hooks/inbox/useTimesDoInbox";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { randomId } from "@/lib/random-id";
import { MENSAGEM_DO_QUE_FALTA, estaArquivado, oQueFaltaNoMenu } from "@/lib/telefonia/falta-no-menu";
import {
  FRASE_DA_OPCAO,
  TEXTO_SUGERIDO,
  montarTextoDoMenu,
  naOrdemFalada,
  trocarMarcador,
} from "@/lib/telefonia/texto-do-menu";
import {
  TAMANHO_MAXIMO_DA_FALA,
  TAMANHO_MAXIMO_DO_NOME_DO_MENU,
  TECLAS_DO_MENU,
  type FalaParaSalvar,
  type MenuPublico,
} from "@/lib/telefonia/vocabulario";
import { Plus, Trash, Warning } from "@/lib/ui/icons";

import { CHAVE_DOS_MENUS, type RespostaDoMenu } from "./api";
import { PreviaDoCampo } from "./PreviaDoCampo";

/** Qual das duas falas do menu uma recusa diz respeito (`details.fala` da rota). */
type QualFala = "menu" | "invalida";

interface LinhaDeOpcao {
  tecla: string;
  time_id: string;
}

interface Rascunho {
  nome: string;
  opcoes: LinhaDeOpcao[];
  time_padrao_id: string;
  /** A fala escrita à mão; `null` = a fala é o texto montado das opções, e muda com elas. */
  textoAMao: string | null;
  /** As opções (tecla → time) quando a fala foi escrita à mão: mudaram depois, a tela avisa. */
  opcoesDoTextoAMao: string;
  texto_invalida: string;
  /** v3: o cliente pode digitar o ramal de alguém. */
  aceita_ramal: boolean;
}

/** O corpo do POST/PATCH — `menuSchema` da rota. */
interface CorpoDoMenu {
  nome: string;
  opcoes: LinhaDeOpcao[];
  time_padrao_id: string;
  fala: FalaParaSalvar;
  fala_invalida: FalaParaSalvar | null;
  aceita_ramal: boolean;
}

/** As opções como uma assinatura comparável (tecla → time, na ordem falada). */
const assinaturaDasOpcoes = (opcoes: readonly LinhaDeOpcao[]) =>
  naOrdemFalada(opcoes)
    .map((o) => `${o.tecla}:${o.time_id}`)
    .join("|");

/**
 * O rascunho de um menu. A fala salva só conta como "escrita à mão" quando não é
 * o texto montado das opções do próprio menu — com os nomes que a rota devolveu
 * junto (`time_nome`), para não depender da lista de times já ter chegado.
 */
function rascunhoInicial(menu: MenuPublico | null, frase: string): Rascunho {
  if (!menu) {
    return {
      nome: "",
      opcoes: [{ tecla: "1", time_id: "" }],
      time_padrao_id: "",
      textoAMao: null,
      opcoesDoTextoAMao: "",
      texto_invalida: "",
      aceita_ramal: false,
    };
  }
  const opcoes = naOrdemFalada(menu.opcoes).map((o) => ({ tecla: o.tecla, time_id: o.time_id }));
  const salvo = menu.fala?.texto ?? "";
  const montado = montarTextoDoMenu(
    menu.opcoes.map((o) => ({ tecla: o.tecla, nomeDoTime: o.time_nome })),
    frase,
  );
  return {
    nome: menu.nome,
    opcoes,
    time_padrao_id: menu.time_padrao_id,
    textoAMao: salvo.trim() && salvo.trim() !== montado.trim() ? salvo : null,
    opcoesDoTextoAMao: assinaturaDasOpcoes(opcoes),
    texto_invalida: menu.fala_invalida?.texto ?? "",
    aceita_ramal: menu.aceita_ramal === true,
  };
}

/** Qual fala a rota apontou na recusa (`details.fala`), se apontou. */
function falaDaRecusa(erro: unknown): QualFala | null {
  const qual = erro instanceof ApiError ? erro.details?.fala : undefined;
  return qual === "menu" || qual === "invalida" ? qual : null;
}

export function EditorDeMenu({
  menu,
  vozAtual,
  times,
  aoFechar,
}: {
  /** `null` = menu novo. */
  menu: MenuPublico | null;
  vozAtual: string | null;
  times: readonly TimeDoInbox[];
  aoFechar: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const frase = t(FRASE_DA_OPCAO);
  const ativos = times.filter((x) => !x.archived);
  // O nome de cada time: o da lista quando ela chega; antes, o que veio com o menu.
  const nomes = new Map<string, string>([
    ...(menu?.opcoes ?? []).map((o) => [o.time_id, o.time_nome] as const),
    ...times.map((x) => [x.id, x.name] as const),
  ]);
  const previaDoMenu = usePreviaDaFala(vozAtual);
  const previaDaInvalida = usePreviaDaFala(vozAtual);
  const [r, setR] = useState<Rascunho>(() => rascunhoInicial(menu, frase));
  // A rota disse que o áudio da fala EM USO sumiu (`previa_ausente`): ela deixa de
  // valer como "o texto não mudou" até uma prévia nova — salvar de novo daria a
  // mesma recusa.
  const [audioSumiu, setAudioSumiu] = useState<Record<QualFala, boolean>>({ menu: false, invalida: false });
  // A chave de idempotência da CRIAÇÃO, por conteúdo. Repetir o mesmo menu (o
  // salvar cuja resposta se perdeu) reusa a chave: se a tentativa anterior chegou a
  // gravar, a rota devolve o menu dela em vez de criar outro. Outro conteúdo ganha
  // chave nova: reusar a antiga daria 409 `idempotency_conflict` quando a
  // tentativa anterior GRAVOU — só gravação vira recibo; recusa (409/422/502) não.
  const recibo = useRef<{ corpo: string; chave: string } | null>(null);
  const campoDoNome = useRef<HTMLInputElement>(null);

  useEffect(() => {
    campoDoNome.current?.focus();
  }, []);

  const textoMontado = montarTextoDoMenu(
    r.opcoes.map((o) => ({ tecla: o.tecla, nomeDoTime: nomes.get(o.time_id) ?? "" })),
    frase,
  );
  const textoDoMenu = r.textoAMao ?? textoMontado;
  const falaDesatualizada = r.textoAMao !== null && assinaturaDasOpcoes(r.opcoes) !== r.opcoesDoTextoAMao;
  const textoDaInvalida = r.texto_invalida.trim();
  const emUsoDoMenu = audioSumiu.menu ? null : (menu?.fala ?? null);
  const emUsoDaInvalida = audioSumiu.invalida ? null : (menu?.fala_invalida ?? null);
  // O que vai no corpo: a prévia DESTE texto, ou a fala em uso se o texto não mudou (D15).
  const falaDoMenu = falaParaSalvar(textoDoMenu, emUsoDoMenu, previaDoMenu.previa);
  const falaDaInvalida = textoDaInvalida ? falaParaSalvar(r.texto_invalida, emUsoDaInvalida, previaDaInvalida.previa) : null;
  const proximaTecla = TECLAS_DO_MENU.find((k) => !r.opcoes.some((o) => o.tecla === k));

  const oQueFalta = oQueFaltaNoMenu({
    nome: r.nome,
    opcoes: r.opcoes,
    time_padrao_id: r.time_padrao_id,
    algumTimeArquivado: r.opcoes.some((o) => estaArquivado(times, o.time_id)) || estaArquivado(times, r.time_padrao_id),
    textoDoMenu,
    faltaPrevia: falaDoMenu === null || (textoDaInvalida !== "" && falaDaInvalida === null),
    audioSumiu: audioSumiu.menu || audioSumiu.invalida,
  });

  const salvar = useMutation({
    mutationFn: async (corpo: CorpoDoMenu) => {
      if (menu) {
        return (await apiClient.patch<{ data: RespostaDoMenu }>(`/api/v1/telefonia/menus/${menu.id}`, corpo)).data;
      }
      const serializado = JSON.stringify(corpo);
      if (recibo.current?.corpo !== serializado) recibo.current = { corpo: serializado, chave: randomId() };
      return (
        await apiClient.post<{ data: RespostaDoMenu }>("/api/v1/telefonia/menus", corpo, {
          idempotencyKey: recibo.current.chave,
        })
      ).data;
    },
    // Nas opções, e aguardado: o editor só fecha depois de a lista reler o menu.
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE_DOS_MENUS }),
  });
  const salvando = salvar.isPending;
  const gerando = previaDoMenu.gerando || previaDaInvalida.gerando;

  const salvarMenu = (corpo: CorpoDoMenu) =>
    // Os efeitos na TELA vão no `mutate`: não rodam depois de um `reset()`.
    salvar.mutate(corpo, {
      onSuccess: () => {
        toast.success(t("Menu salvo."));
        aoFechar();
      },
      onError: (e) => {
        if (!(e instanceof ApiError)) return;
        const qual = falaDaRecusa(e);
        if (!qual) return;
        const previa = qual === "menu" ? previaDoMenu : previaDaInvalida;
        // A prévia enviada não serve mais: a tela volta a pedir "Gerar prévia", que é o que a frase manda.
        if (e.code === "previa_ausente" || e.code === "previa_desatualizada") previa.limpar();
        if (e.code === "previa_ausente") setAudioSumiu((x) => ({ ...x, [qual]: true }));
      },
    });

  const falha = salvar.isError
    ? {
        qual: falaDaRecusa(salvar.error),
        frase: fraseDaFalhaDaFala(salvar.error, t) ?? t("Não foi possível salvar o menu. Tente de novo em instantes."),
      }
    : null;
  const alerta = (onde: QualFala | "geral") =>
    falha && (falha.qual ?? "geral") === onde ? (
      <p role="alert" className="text-sm text-destructive" data-falha-do-salvar={onde}>
        {falha.frase}
      </p>
    ) : null;

  /** Toda edição do rascunho apaga a recusa anterior: ela era de outro conteúdo. */
  const editar = (mudar: (x: Rascunho) => Rascunho) => {
    setR(mudar);
    if (salvar.isError) salvar.reset();
  };
  const mudarOpcao = (i: number, m: Partial<LinhaDeOpcao>) =>
    editar((x) => ({ ...x, opcoes: x.opcoes.map((o, j) => (j === i ? { ...o, ...m } : o)) }));
  const gerar = (previa: ReturnType<typeof usePreviaDaFala>, texto: string) => {
    salvar.reset();
    previa.gerar(texto);
  };

  /** Os times que se escolhem — e, se o escolhido foi arquivado, ele também, para a pessoa ver o que ESTAVA ali. */
  const itensDeTime = (escolhido: string) => (
    <>
      {ativos.map((x) => (
        <SelectItem key={x.id} value={x.id}>
          {x.name}
        </SelectItem>
      ))}
      {times
        .filter((x) => x.id === escolhido && x.archived)
        .map((x) => (
          <SelectItem key={x.id} value={x.id} disabled>
            {`${x.name} (${t("arquivado")})`}
          </SelectItem>
        ))}
    </>
  );

  const nomeDaFalaDoMenu = t("Fala do menu");
  const nomeDaFalaInvalida = t("Fala de tecla inválida");
  const motivo = oQueFalta && !salvando ? t(MENSAGEM_DO_QUE_FALTA[oQueFalta]) : null;

  return (
    <Card className="space-y-4 p-5" data-editor-de-menu>
      <h3 className="text-sm font-semibold">{menu ? t("Editar menu") : t("Novo menu")}</h3>
      <div className="space-y-1.5">
        <Label htmlFor="menu-nome">{t("Nome do menu")}</Label>
        <Input
          ref={campoDoNome}
          id="menu-nome"
          value={r.nome}
          maxLength={TAMANHO_MAXIMO_DO_NOME_DO_MENU}
          disabled={salvando}
          onChange={(e) => editar((x) => ({ ...x, nome: e.target.value }))}
          placeholder={t("Ex.: Atendimento principal")}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("Opções")}</legend>
        {r.opcoes.map((o, i) => {
          const n = String(i + 1);
          return (
            <div key={i} className="flex flex-wrap items-center gap-2" data-opcao-do-menu={i}>
              <span className="text-sm text-muted-foreground">{t("Tecla")}</span>
              <Select value={o.tecla} onValueChange={(v) => mudarOpcao(i, { tecla: v })} disabled={salvando}>
                <SelectTrigger className="w-20" aria-label={trocarMarcador(t("Tecla da opção {n}"), "{n}", n)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TECLAS_DO_MENU.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-sm text-muted-foreground" aria-hidden>
                →
              </span>
              <Select value={o.time_id} onValueChange={(v) => mudarOpcao(i, { time_id: v })} disabled={salvando}>
                <SelectTrigger
                  className="min-w-[12rem] flex-1"
                  aria-label={trocarMarcador(t("Time da opção {n}"), "{n}", n)}
                >
                  <SelectValue placeholder={t("Escolha o time")} />
                </SelectTrigger>
                <SelectContent>{itensDeTime(o.time_id)}</SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("Remover opção")}
                disabled={r.opcoes.length === 1 || salvando}
                onClick={() => editar((x) => ({ ...x, opcoes: x.opcoes.filter((_, j) => j !== i) }))}
              >
                <Trash size={16} aria-hidden />
              </Button>
            </div>
          );
        })}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!proximaTecla || salvando}
          onClick={() => {
            if (proximaTecla) editar((x) => ({ ...x, opcoes: [...x.opcoes, { tecla: proximaTecla, time_id: "" }] }));
          }}
        >
          <Plus size={14} aria-hidden /> {t("Adicionar opção")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("As teclas * e # ficam reservadas.")}</p>
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="menu-padrao">{t("Time padrão (quem não escolhe nada)")}</Label>
        <Select
          value={r.time_padrao_id}
          onValueChange={(v) => editar((x) => ({ ...x, time_padrao_id: v }))}
          disabled={salvando}
        >
          <SelectTrigger id="menu-padrao">
            <SelectValue placeholder={t("Escolha o time")} />
          </SelectTrigger>
          <SelectContent>{itensDeTime(r.time_padrao_id)}</SelectContent>
        </Select>
      </div>

      <div className="flex items-start gap-3 rounded-md border border-border p-3">
        <Switch
          id="menu-aceita-ramal"
          checked={r.aceita_ramal}
          onCheckedChange={(v) => editar((x) => ({ ...x, aceita_ramal: v }))}
          disabled={salvando}
        />
        <div className="space-y-0.5">
          <Label htmlFor="menu-aceita-ramal">{t("O cliente pode digitar o ramal")}</Label>
          <p className="text-xs text-muted-foreground">
            {t(
              "Quem sabe o ramal digita e fala direto com a pessoa. As opções de uma tecla continuam valendo, com 2 segundos de espera para ver se vem mais dígito. Diga isso na fala do menu.",
            )}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="menu-texto">{nomeDaFalaDoMenu}</Label>
        <Textarea
          id="menu-texto"
          rows={3}
          maxLength={TAMANHO_MAXIMO_DA_FALA}
          value={textoDoMenu}
          disabled={salvando}
          onChange={(e) =>
            editar((x) => ({ ...x, textoAMao: e.target.value, opcoesDoTextoAMao: assinaturaDasOpcoes(x.opcoes) }))
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            {r.textoAMao === null
              ? t("Montada a partir das opções. Você pode editar antes de gerar.")
              : t("Fala escrita à mão: ela não acompanha as mudanças nas opções.")}
          </p>
          {r.textoAMao !== null ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              disabled={salvando}
              onClick={() => editar((x) => ({ ...x, textoAMao: null }))}
            >
              {t("Usar o texto montado")}
            </Button>
          ) : null}
        </div>
        {falaDesatualizada ? (
          <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400" data-fala-desatualizada>
            <Warning size={14} aria-hidden className="mt-px shrink-0" />
            <span>
              {t(
                "As opções mudaram depois que a fala foi escrita. Confira se ela ainda diz a tecla e o time certos — ou use o texto montado das opções.",
              )}
            </span>
          </p>
        ) : null}
        <PreviaDoCampo
          qual="menu"
          nome={nomeDaFalaDoMenu}
          texto={textoDoMenu}
          emUso={emUsoDoMenu}
          paraSalvar={falaDoMenu}
          previa={previaDoMenu}
          vozAtual={vozAtual}
          travado={salvando}
          aoGerar={() => gerar(previaDoMenu, textoDoMenu)}
        />
        {alerta("menu")}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="menu-invalida">{t("Fala de tecla inválida (opcional)")}</Label>
        <Textarea
          id="menu-invalida"
          rows={2}
          maxLength={TAMANHO_MAXIMO_DA_FALA}
          value={r.texto_invalida}
          disabled={salvando}
          placeholder={t(TEXTO_SUGERIDO.invalid)}
          onChange={(e) => editar((x) => ({ ...x, texto_invalida: e.target.value }))}
        />
        <p className="text-xs text-muted-foreground">
          {t("Toca quando o cliente aperta uma tecla que não é opção, antes de repetir o menu.")}
        </p>
        {textoDaInvalida ? (
          <PreviaDoCampo
            qual="invalid"
            nome={nomeDaFalaInvalida}
            texto={r.texto_invalida}
            emUso={emUsoDaInvalida}
            paraSalvar={falaDaInvalida}
            previa={previaDaInvalida}
            vozAtual={vozAtual}
            travado={salvando}
            aoGerar={() => gerar(previaDaInvalida, r.texto_invalida)}
          />
        ) : null}
        {alerta("invalida")}
      </div>

      {alerta("geral")}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          aria-describedby={motivo ? "menu-falta" : undefined}
          onClick={() => {
            if (oQueFalta === null && falaDoMenu) {
              salvarMenu({
                nome: r.nome.trim(),
                opcoes: r.opcoes,
                time_padrao_id: r.time_padrao_id,
                fala: falaDoMenu,
                fala_invalida: falaDaInvalida,
                aceita_ramal: r.aceita_ramal,
              });
            }
          }}
          disabled={oQueFalta !== null || salvando || gerando}
        >
          {salvando ? t("Salvando…") : t("Salvar menu")}
        </Button>
        <Button type="button" variant="ghost" onClick={aoFechar} disabled={salvando}>
          {t("Cancelar")}
        </Button>
        {motivo ? (
          <p id="menu-falta" className="text-xs text-muted-foreground">
            {motivo}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
