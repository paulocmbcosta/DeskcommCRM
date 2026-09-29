"use client";
/**
 * Conexões › Telefone › Menus (desenho da fase 2, §6.2 e §8).
 *
 * O menu de voz (URA) da organização: tecla → time, o time padrão para quem não
 * escolhe, e a fala — montada a partir das opções ("Para Suporte, digite 1.", no
 * idioma de quem monta) e editável. "Gerar prévia" faz o áudio (a ÚNICA hora em
 * que a ElevenLabs trabalha, D15), a pessoa ouve, e "Salvar menu" só aceita a
 * prévia do texto que está no campo — ou a fala em uso, se o texto não mudou. O
 * editor mora em `EditorDeMenu.tsx`; aqui ficam a lista e o cartão de cada menu.
 * Um menu serve a vários números; quem liga o menu a um número é a aba Números.
 *
 * O bloco "Últimos 7 dias" é o laço de retorno da URA (§8): as ligações
 * ENCERRADAS que passaram pelo menu (a rota já filtra) e, quando muita gente não
 * escolhe opção nenhuma, o alerta de `menuConfunde` — a regra é a de
 * `lib/telefonia/ultimos-sete-dias.ts`, não uma cópia aqui. As parcelas fecham o
 * total: escolhas por uma tecla que saiu do menu entram em "Outras teclas".
 *
 * O cartão REORDENA as opções: a rota as devolve em ordem de texto (o 0 primeiro),
 * e o cartão e o editor as mostram como a fala as diz, com o 0 por último — a regra
 * é a do texto do menu (`naOrdemFalada`, texto-do-menu.ts), não uma cópia aqui.
 *
 * Um time ARQUIVADO — que a rota recusaria com `time_invalido` — aparece no cartão
 * (é para cá que a Central aponta "menu manda para time arquivado") e trava o
 * salvar no editor até a pessoa escolher outro. Sem a lista de times (a leitura
 * falhou), a tela diz isso e não abre menu novo: cada opção leva a um time.
 *
 * Só um menu fica aberto no editor. Ao fechá-lo, o foco volta ao botão que o
 * abriu ("Editar" daquele menu, ou "Novo menu").
 *
 * A página inteira de Conexões é de admin, e as rotas dos menus também: a tela
 * não tem o que esconder por papel além disso, mas uma leitura recusada (403)
 * diz quem pode — a rota é a autoridade.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { OuvirFala } from "@/components/telefonia/OuvirFala";
import { fraseDaFalhaDaFala } from "@/components/telefonia/usePreviaDaFala";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { useTimesDoInbox, type TimeDoInbox } from "@/hooks/inbox/useTimesDoInbox";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { estaArquivado } from "@/lib/telefonia/falta-no-menu";
import { naOrdemFalada, trocarMarcador } from "@/lib/telefonia/texto-do-menu";
import { menuConfunde } from "@/lib/telefonia/ultimos-sete-dias";
import type { MenuPublico } from "@/lib/telefonia/vocabulario";
import { Archive, PencilSimple, Plus, TreeStructure, Warning } from "@/lib/ui/icons";

import { CHAVE_DOS_MENUS, useMenusDoTelefone, useVozDoTelefone } from "./api";
import { EditorDeMenu } from "./EditorDeMenu";
import { EstadoDaFala } from "./EstadoDaFala";
import { TelefoniaDesligada } from "./TelefoniaDesligada";

/** O editor aberto: o id do menu, ou um menu novo. */
const NOVO = "novo";

export function MenusDoTelefone() {
  const t = useT();
  const consulta = useMenusDoTelefone();
  const voz = useVozDoTelefone();
  const times = useTimesDoInbox();
  const [editando, setEditando] = useState<string | null>(null);
  // Os botões que abrem o editor: fechado o editor, o foco volta a quem o abriu.
  const botoesDeEditar = useRef(new Map<string, HTMLButtonElement>());
  const botaoNovo = useRef<HTMLButtonElement>(null);
  const editavaAntes = useRef<string | null>(null);

  useEffect(() => {
    const antes = editavaAntes.current;
    editavaAntes.current = editando;
    if (editando !== null || antes === null) return;
    // O menu pode ter saído da lista enquanto se editava (arquivado noutra aba): o "Novo menu" fica.
    const alvo = antes === NOVO ? botaoNovo.current : (botoesDeEditar.current.get(antes) ?? botaoNovo.current);
    alvo?.focus();
  }, [editando]);

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
        {times.isError ? (
          <p className="text-sm text-destructive">{t("Não foi possível carregar os times. Recarregue a página.")}</p>
        ) : semTimeAtivo ? (
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
            refDoEditar={(el) => {
              if (el) botoesDeEditar.current.set(m.id, el);
              else botoesDeEditar.current.delete(m.id);
            }}
          />
        ),
      )}

      {editando === NOVO ? (
        <EditorDeMenu menu={null} vozAtual={vozAtual} times={listaDeTimes} aoFechar={() => setEditando(null)} />
      ) : editando === null ? (
        <Button
          ref={botaoNovo}
          type="button"
          variant="outline"
          onClick={() => setEditando(NOVO)}
          // Sem a voz não se gera a fala; sem a lista de times (ou sem time ativo) não há opção.
          disabled={!vozAtual || !times.isSuccess || semTimeAtivo}
        >
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
  refDoEditar,
}: {
  menu: MenuPublico;
  vozAtual: string | null;
  times: readonly TimeDoInbox[];
  /** Outro menu está aberto no editor: este não abre (o rascunho de lá não se perde). */
  bloqueado: boolean;
  aoEditar: () => void;
  /** O botão "Editar", para a lista devolver o foco a ele quando o editor fechar. */
  refDoEditar: (el: HTMLButtonElement | null) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const u = menu.ultimos_7_dias;
  const opcoes = naOrdemFalada(menu.opcoes);
  const emUso = menu.numeros.length > 0;
  // As escolhas que não cabem nas parcelas de hoje: uma tecla que saiu do menu (ou
  // uma escolha sem tecla gravada). Com elas as parcelas fecham o total.
  const outrasTeclas =
    u.total -
    opcoes.reduce((soma, o) => soma + (u.por_tecla[o.tecla] ?? 0), 0) -
    u.sem_escolha -
    u.tecla_errada -
    u.desligou_no_menu;

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
        <Button
          ref={refDoEditar}
          type="button"
          variant="outline"
          size="sm"
          onClick={aoEditar}
          disabled={bloqueado || arquivar.isPending}
        >
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
            {trocarMarcador(
              t("Este menu leva a um time arquivado ({times}), que não recebe ligações. Edite o menu e escolha outro time."),
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
            <li>{u.total === 1 ? t("1 ligação") : trocarMarcador(t("{n} ligações"), "{n}", String(u.total))}</li>
            {opcoes.map((o) => (
              <li key={o.tecla}>
                {t("Tecla")} {`${o.tecla} (${o.time_nome}): ${u.por_tecla[o.tecla] ?? 0}`}
              </li>
            ))}
            {outrasTeclas > 0 ? (
              <li>
                {t("Outras teclas")}: {outrasTeclas}
              </li>
            ) : null}
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
