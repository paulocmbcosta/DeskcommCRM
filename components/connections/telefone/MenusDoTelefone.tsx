"use client";
/**
 * Conexões › Telefone › Menus (desenho da fase 2, §6.2 e §8).
 *
 * O menu de voz (URA) da organização: tecla → time, o time padrão para quem não
 * escolhe, e a fala — montada a partir das opções ("Para Suporte, digite 1.", no
 * idioma de quem monta) e editável. "Gerar prévia" faz o áudio (a ÚNICA hora em
 * que a ElevenLabs trabalha, D15), a pessoa ouve aqui, e "Salvar menu" só aceita
 * a prévia do texto que está no campo — ou a fala em uso, se o texto não mudou.
 * Um menu serve a vários números; quem liga o menu a um número é a aba Números.
 *
 * O bloco "Últimos 7 dias" é o laço de retorno da URA (§8): as ligações
 * ENCERRADAS que passaram pelo menu (a rota já filtra) e, quando muita gente não
 * escolhe opção nenhuma, o alerta de `menuConfunde` — a regra é a de
 * `lib/telefonia/ultimos-sete-dias.ts`, não uma cópia aqui.
 *
 * O cartão REORDENA as opções: a rota as devolve em ordem de texto (o 0 primeiro),
 * e o cartão e o editor as mostram como a fala as diz, com o 0 por último — a regra
 * é a do texto do menu (`naOrdemFalada`, texto-do-menu.ts), não uma cópia aqui.
 *
 * As regras do editor também não são cópias: tecla repetida é `teclaRepetida`,
 * as teclas e o teto do nome espelham os CHECKs do banco (`vocabulario.ts`), e a
 * prévia é a máquina de `usePreviaDaFala` (amarrada à voz atual). Um time
 * ARQUIVADO — que a rota recusaria com `time_invalido` — aparece no cartão (é
 * para cá que a Central aponta "menu manda para time arquivado") e trava o
 * salvar até a pessoa escolher outro.
 *
 * Recusas da rota aparecem com a frase DELA (`fraseDaFalhaDaFala`), ao lado da
 * fala certa quando a rota diz qual (`details.fala`): "o áudio da fala do menu não
 * foi encontrado, gere a prévia de novo" — e, nesse caso, a fala em uso deixa de
 * valer como "nada mudou" até a prévia nova, senão o botão convidaria à mesma
 * recusa. Nunca o texto cru do erro: o 504 de um proxy traz HTML.
 *
 * Um gesto por vez: enquanto salva, os campos e "Gerar prévia" travam; enquanto
 * uma prévia é gerada, "Salvar menu" trava; e só um menu fica aberto no editor.
 *
 * A página inteira de Conexões é de admin, e as rotas dos menus também: a tela
 * não tem o que esconder por papel além disso, mas uma leitura recusada (403)
 * diz quem pode — a rota é a autoridade.
 */
import Link from "next/link";
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { OuvirFala } from "@/components/telefonia/OuvirFala";
import { OuvirPrevia } from "@/components/telefonia/OuvirPrevia";
import {
  falaParaSalvar,
  fraseDaFalhaDaFala,
  mensagemDaFalhaDaPrevia,
  usePreviaDaFala,
} from "@/components/telefonia/usePreviaDaFala";
import { useT } from "@/hooks/i18n/useT";
import { useTimesDoInbox, type TimeDoInbox } from "@/hooks/inbox/useTimesDoInbox";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { randomId } from "@/lib/random-id";
import { FRASE_DA_OPCAO, TEXTO_SUGERIDO, montarTextoDoMenu, naOrdemFalada } from "@/lib/telefonia/texto-do-menu";
import { menuConfunde } from "@/lib/telefonia/ultimos-sete-dias";
import {
  TAMANHO_MAXIMO_DA_FALA,
  TAMANHO_MAXIMO_DO_NOME_DO_MENU,
  TECLAS_DO_MENU,
  teclaRepetida,
  type FalaParaSalvar,
  type FalaPublica,
  type MenuPublico,
} from "@/lib/telefonia/vocabulario";
import { Archive, PencilSimple, Play, Plus, Trash, TreeStructure, Warning } from "@/lib/ui/icons";

import { CHAVE_DOS_MENUS, useMenusDoTelefone, useVozDoTelefone, type RespostaDoMenu } from "./api";
import { EstadoDaFala } from "./EstadoDaFala";
import { TelefoniaDesligada } from "./TelefoniaDesligada";

/** O editor aberto: o id do menu, ou um menu novo. */
const NOVO = "novo";

/** Qual das duas falas do menu uma recusa diz respeito (`details.fala` da rota). */
type QualFala = "menu" | "invalida";

/** O time existe na lista e foi arquivado. Um id que a lista não conhece fica com a rota (`time_invalido`). */
const estaArquivado = (times: readonly TimeDoInbox[], id: string) => times.some((x) => x.id === id && x.archived);

export function MenusDoTelefone() {
  const t = useT();
  const consulta = useMenusDoTelefone();
  const voz = useVozDoTelefone();
  const times = useTimesDoInbox();
  const [editando, setEditando] = useState<string | null>(null);

  if (consulta.isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (consulta.isError || !consulta.data) {
    const semPermissao = consulta.error instanceof ApiError && consulta.error.status === 403;
    return (
      <Card className="p-5 text-sm text-muted-foreground">
        {semPermissao
          ? t("Só quem administra a organização gerencia os menus de voz.")
          : t("Não foi possível carregar os menus. Recarregue a página.")}
      </Card>
    );
  }
  if (!consulta.data.oferecida) return <TelefoniaDesligada />;

  const menus = consulta.data.menus;
  const listaDeTimes = times.data ?? [];
  const semTimeAtivo = times.isSuccess && !listaDeTimes.some((x) => !x.archived);
  const vozAtual = voz.data?.voz?.voice_id ?? null;
  const semVoz = voz.isSuccess && (!voz.data.chave.cadastrada || !voz.data.voz);

  return (
    <div className="space-y-4">
      <Card className="space-y-2 p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <TreeStructure size={18} aria-hidden /> {t("Menus de voz")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "O menu atende a ligação, fala as opções e leva o cliente ao time da tecla que ele apertar. Quem não escolhe vai para o time padrão. Depois de pronto, ligue o menu a um número na aba Números.",
          )}
        </p>
        {voz.isError ? (
          <p className="text-sm text-destructive">{t("Não foi possível carregar a voz do telefone. Recarregue a página.")}</p>
        ) : semVoz ? (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {t("Para gerar a fala do menu, cadastre a chave da ElevenLabs e escolha a voz na aba Voz e falas.")}
          </p>
        ) : null}
        {semTimeAtivo ? (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {t("Cada opção do menu leva a um time, e esta organização ainda não tem nenhum ativo.")}{" "}
            <Link href="/app/settings/teams" className="font-medium underline underline-offset-2">
              {t("Criar um time")}
            </Link>
          </p>
        ) : null}
      </Card>

      {menus.map((m) =>
        editando === m.id ? (
          <EditorDeMenu key={m.id} menu={m} vozAtual={vozAtual} times={listaDeTimes} aoFechar={() => setEditando(null)} />
        ) : (
          <CartaoDoMenu
            key={m.id}
            menu={m}
            vozAtual={vozAtual}
            times={listaDeTimes}
            bloqueado={editando !== null}
            aoEditar={() => setEditando(m.id)}
          />
        ),
      )}

      {editando === NOVO ? (
        <EditorDeMenu menu={null} vozAtual={vozAtual} times={listaDeTimes} aoFechar={() => setEditando(null)} />
      ) : editando === null ? (
        <Button type="button" variant="outline" onClick={() => setEditando(NOVO)} disabled={!vozAtual || semTimeAtivo}>
          <Plus size={16} aria-hidden /> {t("Novo menu")}
        </Button>
      ) : null}
    </div>
  );
}

function CartaoDoMenu({
  menu,
  vozAtual,
  times,
  bloqueado,
  aoEditar,
}: {
  menu: MenuPublico;
  vozAtual: string | null;
  times: readonly TimeDoInbox[];
  /** Outro menu está aberto no editor: este não abre (o rascunho de lá não se perde). */
  bloqueado: boolean;
  aoEditar: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const u = menu.ultimos_7_dias;
  const opcoes = naOrdemFalada(menu.opcoes);
  const emUso = menu.numeros.length > 0;

  const arquivar = useMutation({
    mutationFn: () => apiClient.delete(`/api/v1/telefonia/menus/${menu.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE_DOS_MENUS }),
  });
  const falhaAoArquivar = arquivar.isError
    ? (fraseDaFalhaDaFala(arquivar.error, t) ?? t("Não foi possível arquivar o menu. Tente de novo em instantes."))
    : null;

  // Os times do menu que foram arquivados — o que a Central manda revisar aqui.
  const arquivados = [
    ...new Set(
      [
        ...opcoes.map((o) => ({ id: o.time_id, nome: o.time_nome })),
        { id: menu.time_padrao_id, nome: menu.time_padrao_nome },
      ]
        .filter((x) => estaArquivado(times, x.id))
        .map((x) => x.nome),
    ),
  ];

  return (
    <Card className="space-y-3 p-4" data-menu={menu.id}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{menu.nome}</p>
        <EstadoDaFala fala={menu.fala} vozAtual={vozAtual} />
        <Button type="button" variant="outline" size="sm" onClick={aoEditar} disabled={bloqueado || arquivar.isPending}>
          <PencilSimple size={14} aria-hidden /> {t("Editar")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={emUso || bloqueado || arquivar.isPending}
          onClick={() => {
            if (!window.confirm(t("Arquivar este menu? Ele sai da lista e não pode mais ser ligado a um número."))) return;
            arquivar.mutate(undefined, { onSuccess: () => toast.success(t("Menu arquivado.")) });
          }}
        >
          <Archive size={14} aria-hidden /> {t("Arquivar")}
        </Button>
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {opcoes.map((o) => (
          <li key={o.tecla} data-opcao-no-cartao={o.tecla}>
            {t("Tecla")} {`${o.tecla} → ${o.time_nome}`}
          </li>
        ))}
        <li>
          {t("Padrão (sem escolha):")} {menu.time_padrao_nome}
        </li>
      </ul>

      {arquivados.length > 0 ? (
        <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400" data-time-arquivado>
          <Warning size={14} aria-hidden className="mt-px shrink-0" />
          <span>
            {t("Este menu leva a um time arquivado ({times}), que não recebe ligações. Edite o menu e escolha outro time.").replace(
              "{times}",
              arquivados.join(", "),
            )}
          </span>
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {emUso
          ? `${t("Usado por:")} ${menu.numeros.join(", ")}. ${t("Para arquivar, troque antes o destino desses números na aba Números.")}`
          : t("Nenhum número usa este menu ainda. Ligue-o a um número na aba Números.")}
      </p>
      {menu.fala?.status === "ready" ? <OuvirFala falaId={menu.fala.id} nome={menu.nome} /> : null}

      <div className="rounded-md border bg-muted/30 p-3 text-xs" data-testid="menu-ultimos-7-dias">
        <p className="font-medium">{t("Últimos 7 dias")}</p>
        {u.total === 0 ? (
          <p className="text-muted-foreground">{t("Nenhuma ligação passou por este menu ainda.")}</p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <li>{u.total === 1 ? t("1 ligação") : t("{n} ligações").replace("{n}", String(u.total))}</li>
            {opcoes.map((o) => (
              <li key={o.tecla}>
                {t("Tecla")} {`${o.tecla} (${o.time_nome}): ${u.por_tecla[o.tecla] ?? 0}`}
              </li>
            ))}
            <li>
              {t("Sem escolha")}: {u.sem_escolha}
            </li>
            <li>
              {t("Tecla errada")}: {u.tecla_errada}
            </li>
            <li>
              {t("Desligou no menu")}: {u.desligou_no_menu}
            </li>
          </ul>
        )}
        {menuConfunde(u) ? (
          <p className="mt-2 flex items-start gap-1.5 text-amber-700 dark:text-amber-400" data-menu-confunde>
            <Warning size={14} aria-hidden className="mt-px shrink-0" />
            <span>
              {t(
                "Muita gente não escolhe uma opção: cai no time padrão ou desliga no meio do menu. Talvez a fala esteja confusa ou longa demais — reescreva e gere a prévia de novo.",
              )}
            </span>
          </p>
        ) : null}
      </div>

      {falhaAoArquivar ? (
        <p role="alert" className="text-sm text-destructive">
          {falhaAoArquivar}
        </p>
      ) : null}
    </Card>
  );
}

interface LinhaDeOpcao {
  tecla: string;
  time_id: string;
}

interface Rascunho {
  nome: string;
  opcoes: LinhaDeOpcao[];
  time_padrao_id: string;
  /** Texto escrito à mão; enquanto `textoEditado` for falso, vale o montado das opções. */
  texto_menu: string;
  textoEditado: boolean;
  texto_invalida: string;
}

/** O corpo do POST/PATCH — `menuSchema` da rota. */
interface CorpoDoMenu {
  nome: string;
  opcoes: LinhaDeOpcao[];
  time_padrao_id: string;
  fala: FalaParaSalvar;
  fala_invalida: FalaParaSalvar | null;
}

function rascunhoInicial(menu: MenuPublico | null): Rascunho {
  if (!menu) {
    return { nome: "", opcoes: [{ tecla: "1", time_id: "" }], time_padrao_id: "", texto_menu: "", textoEditado: false, texto_invalida: "" };
  }
  return {
    nome: menu.nome,
    opcoes: naOrdemFalada(menu.opcoes).map((o) => ({ tecla: o.tecla, time_id: o.time_id })),
    time_padrao_id: menu.time_padrao_id,
    texto_menu: menu.fala?.texto ?? "",
    textoEditado: Boolean(menu.fala?.texto),
    texto_invalida: menu.fala_invalida?.texto ?? "",
  };
}

/** Qual fala a rota apontou na recusa (`details.fala`), se apontou. */
function falaDaRecusa(erro: unknown): QualFala | null {
  const qual = erro instanceof ApiError ? erro.details?.fala : undefined;
  return qual === "menu" || qual === "invalida" ? qual : null;
}

function EditorDeMenu({
  menu,
  vozAtual,
  times,
  aoFechar,
}: {
  menu: MenuPublico | null;
  vozAtual: string | null;
  times: readonly TimeDoInbox[];
  aoFechar: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  // Os ids dos campos são FIXOS (`menu-nome`, `menu-padrao`, `menu-texto`,
  // `menu-invalida`): a prova pela tela (tests/e2e) os procura, e só um editor
  // fica aberto por vez, então não colidem.
  const ativos = times.filter((x) => !x.archived);
  const nomeDoTimeAtivo = (timeId: string) => ativos.find((x) => x.id === timeId)?.name ?? "";
  const previaDoMenu = usePreviaDaFala(vozAtual);
  const previaDaInvalida = usePreviaDaFala(vozAtual);
  const [r, setR] = useState<Rascunho>(() => rascunhoInicial(menu));
  // A rota disse que o áudio da fala EM USO sumiu (`previa_ausente`): ela deixa de
  // valer como "o texto não mudou" até uma prévia nova — salvar de novo daria a
  // mesma recusa.
  const [audioSumiu, setAudioSumiu] = useState<Record<QualFala, boolean>>({ menu: false, invalida: false });
  // A chave de idempotência da CRIAÇÃO, por conteúdo: repetir o mesmo menu (o
  // salvar que esbarrou numa trava, ou cuja resposta se perdeu) é a mesma
  // criação; outro conteúdo é outra, e reusar a chave seria um 409 sem sentido.
  const recibo = useRef<{ corpo: string; chave: string } | null>(null);

  const textoMontado = montarTextoDoMenu(
    r.opcoes.map((o) => ({ tecla: o.tecla, nomeDoTime: nomeDoTimeAtivo(o.time_id) })),
    t(FRASE_DA_OPCAO),
  );
  const textoDoMenu = r.textoEditado ? r.texto_menu : textoMontado;
  const textoDaInvalida = r.texto_invalida.trim();
  const emUsoDoMenu = audioSumiu.menu ? null : (menu?.fala ?? null);
  const emUsoDaInvalida = audioSumiu.invalida ? null : (menu?.fala_invalida ?? null);
  // O que vai no corpo: a prévia DESTE texto, ou a fala em uso se o texto não mudou (D15).
  const falaDoMenu = falaParaSalvar(textoDoMenu, emUsoDoMenu, previaDoMenu.previa);
  const falaDaInvalida = textoDaInvalida ? falaParaSalvar(r.texto_invalida, emUsoDaInvalida, previaDaInvalida.previa) : null;
  const faltaPrevia = falaDoMenu === null || (textoDaInvalida !== "" && falaDaInvalida === null);
  const proximaTecla = TECLAS_DO_MENU.find((k) => !r.opcoes.some((o) => o.tecla === k));
  const timeArquivado = r.opcoes.some((o) => estaArquivado(times, o.time_id)) || estaArquivado(times, r.time_padrao_id);

  // Por que o "Salvar menu" está travado — a primeira coisa que falta, dita à pessoa.
  const falta = !r.nome.trim()
    ? t("Dê um nome ao menu.")
    : r.opcoes.length === 0
      ? t("O menu precisa de pelo menos uma opção.")
      : r.opcoes.some((o) => !o.time_id)
        ? t("Escolha o time de cada opção.")
        : teclaRepetida(r.opcoes)
          ? t("Cada tecla só pode levar a um time.")
          : !r.time_padrao_id
            ? t("Escolha o time padrão.")
            : timeArquivado
              ? t("Um time escolhido foi arquivado. Escolha outro time.")
              : !textoDoMenu.trim()
                ? t("Escreva a fala do menu.")
                : faltaPrevia
                  ? t("Gere a prévia de cada fala que mudou antes de salvar o menu.")
                  : null;

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

  return (
    <Card className="space-y-4 p-5" data-editor-de-menu>
      <h3 className="text-sm font-semibold">{menu ? t("Editar menu") : t("Novo menu")}</h3>
      <div className="space-y-1.5">
        <Label htmlFor="menu-nome">{t("Nome do menu")}</Label>
        <Input
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
        {r.opcoes.map((o, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2" data-opcao-do-menu={i}>
            <span className="text-sm text-muted-foreground">{t("Tecla")}</span>
            <Select value={o.tecla} onValueChange={(v) => mudarOpcao(i, { tecla: v })} disabled={salvando}>
              <SelectTrigger className="w-20" aria-label={t("Tecla da opção")}>
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
              <SelectTrigger className="min-w-[12rem] flex-1" aria-label={t("Time da opção")}>
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
        ))}
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

      <div className="space-y-1.5">
        <Label htmlFor="menu-texto">{nomeDaFalaDoMenu}</Label>
        <Textarea
          id="menu-texto"
          rows={3}
          maxLength={TAMANHO_MAXIMO_DA_FALA}
          value={textoDoMenu}
          disabled={salvando}
          onChange={(e) => editar((x) => ({ ...x, texto_menu: e.target.value, textoEditado: true }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">{t("Montada a partir das opções. Você pode editar antes de gerar.")}</p>
          {r.textoEditado ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              disabled={salvando}
              onClick={() => editar((x) => ({ ...x, textoEditado: false, texto_menu: "" }))}
            >
              {t("Refazer a partir das opções")}
            </Button>
          ) : null}
        </div>
        <PreviaDoCampo
          qual="menu"
          nome={nomeDaFalaDoMenu}
          texto={textoDoMenu}
          emUso={menu?.fala ?? null}
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
            emUso={menu?.fala_invalida ?? null}
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
          onClick={() => {
            if (falta === null && falaDoMenu) {
              salvarMenu({
                nome: r.nome.trim(),
                opcoes: r.opcoes,
                time_padrao_id: r.time_padrao_id,
                fala: falaDoMenu,
                fala_invalida: falaDaInvalida,
              });
            }
          }}
          disabled={falta !== null || salvando || gerando}
        >
          {salvando ? t("Salvando…") : t("Salvar menu")}
        </Button>
        <Button type="button" variant="ghost" onClick={aoFechar} disabled={salvando}>
          {t("Cancelar")}
        </Button>
        {falta && !salvando ? <p className="text-xs text-muted-foreground">{falta}</p> : null}
      </div>
    </Card>
  );
}

/** "Gerar prévia" de uma fala do menu, o estado dela e o que dá para ouvir (a prévia, ou a fala em uso). */
function PreviaDoCampo({
  qual,
  nome,
  texto,
  emUso,
  paraSalvar,
  previa,
  vozAtual,
  travado,
  aoGerar,
}: {
  /** O tipo da fala (`phone_prompts.kind`), para o seletor `data-gerar-previa`. */
  qual: "menu" | "invalid";
  nome: string;
  texto: string;
  /** A fala EM USO (o selo diz o que as ligações tocam). */
  emUso: FalaPublica | null;
  /** O que o "Salvar menu" mandaria por esta fala agora (`null` = falta a prévia). */
  paraSalvar: FalaParaSalvar | null;
  previa: ReturnType<typeof usePreviaDaFala>;
  vozAtual: string | null;
  /** O salvar está em andamento: nada de pagar uma prévia no meio dele. */
  travado: boolean;
  aoGerar: () => void;
}) {
  const t = useT();
  const emUsoNoCampo = emUso?.status === "ready" && emUso.texto === texto.trim();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-gerar-previa={qual}
        onClick={aoGerar}
        disabled={!vozAtual || !texto.trim() || previa.gerando || travado}
      >
        <Play size={14} aria-hidden /> {previa.gerando ? t("Gerando a prévia…") : t("Gerar prévia")}
      </Button>
      <EstadoDaFala
        fala={emUso}
        vozAtual={vozAtual}
        gerando={previa.gerando}
        previaNaoSalva={paraSalvar !== null && paraSalvar.hash !== emUso?.hash}
        erro={mensagemDaFalhaDaPrevia(previa.erroPara(texto), t)}
      />
      {previa.previa && previa.valePara(texto) ? (
        <OuvirPrevia audio={previa.previa.audio} aoOuvir={previa.marcarOuvida} nome={nome} />
      ) : emUsoNoCampo && emUso ? (
        <OuvirFala falaId={emUso.id} nome={nome} />
      ) : null}
    </div>
  );
}
