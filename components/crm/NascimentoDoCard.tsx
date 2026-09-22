"use client";

/**
 * "QUANDO O CARD NASCE" — a superfície da regra `settings.crm.nascimento_do_card`.
 *
 * Mora na tela de funis porque é dela a pergunta "por que este card está aqui?".
 * Quem não é admin VÊ a regra em vigor (saber por que um card não nasceu é
 * direito de quem opera), mas só o admin do TENANT a muda — a action confere
 * de novo, e SEM o atalho de platform admin que o resto da tela concede (é
 * decisão de controlador, mesma régua de `fn_definir_cliente_pela_agenda`).
 *
 * ⚠️ `sem_chave_openrouter` fica na tela DEPOIS do toast sumir: o rádio segue
 * marcado em "Só conversas comerciais" (não revertemos a escolha do usuário —
 * ele ainda pode corrigir a chave e salvar de novo), mas essa escolha ainda
 * NÃO está salva. Um aviso fixo com link para IA › Credenciais é o que impede
 * a pessoa de fechar a tela achando que a regra já vale.
 *
 * ⚠️ `tente_de_novo` é a corrida otimista da action (`updated_at` mudou entre
 * a leitura e a gravação dela): `router.refresh()` já traz o `inicial` fresco
 * do servidor — a mensagem não pode mandar "recarregue a página" (o
 * `refresh()` FEZ isso; pedir de novo faria a pessoa perder o rascunho
 * achando que precisa recarregar na mão) — e `SecaoNascimentoDoCard`
 * (exportado abaixo, é o que a página usa) remonta este componente pela
 * `key` nova assim que o `inicial` atualizado chega.
 */
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";

import { definirNascimentoDoCard, type ErroNascimentoDoCard } from "@/app/actions/settings/definirNascimentoDoCard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import {
  LIMIARES_DO_CLASSIFICADOR,
  type ModoDeNascimentoDoCard,
  type NascimentoDoCard as Regra,
} from "@/lib/schemas/settings";

const MENSAGEM_DO_ERRO: Record<ErroNascimentoDoCard, string> = {
  invalido: "Escolha um modo e uma certeza mínima válidos.",
  sessao: "Sua sessão expirou. Entre de novo.",
  somente_leitura: "Acompanhamento somente leitura ou encerrado.",
  sem_empresa: "Nenhuma empresa ativa.",
  sem_permissao: "Só um administrador pode mudar essa regra.",
  mfa: "Confirme a verificação em duas etapas.",
  sem_chave_openrouter: "Cadastre e valide uma chave da OpenRouter em IA › Credenciais antes de ligar esta regra.",
  tente_de_novo: "Outra pessoa mudou esta configuração agora. Confira e salve de novo.",
  falha: "Não consegui salvar essa mudança agora.",
};

const TITULO_ID = "nascimento-do-card-titulo";

function Opcao({
  id,
  descricaoId,
  valor,
  atual,
  titulo,
  corpo,
  onPick,
  disabled,
  podeEditar,
}: {
  id: string;
  descricaoId: string;
  valor: ModoDeNascimentoDoCard;
  atual: ModoDeNascimentoDoCard;
  titulo: string;
  corpo: string;
  onPick: (v: ModoDeNascimentoDoCard) => void;
  disabled: boolean;
  podeEditar: boolean;
}) {
  const t = useT();
  const marcado = atual === valor;
  // Quem NÃO pode editar só vê o rádio — nunca clica, então `atual` nunca sai
  // de `inicial.modo`, e "marcado" AQUI é sempre "é a regra em vigor". Gira
  // em `podeEditar`, não em `disabled`: durante o `salvando` de um ADMIN,
  // `disabled` também é `true`, mas a opção marcada ali é a escolha ainda NÃO
  // confirmada — rotulá-la "Em vigor" nesse instante seria mentira.
  const emVigor = !podeEditar && marcado;
  return (
    <label
      data-testid={`opcao-nascimento-${valor}`}
      data-marcada={marcado ? "sim" : "nao"}
      className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
        disabled
          ? marcado
            ? // Desabilitado E marcado: o destaque FICA (atenuado na borda, não
              // no texto) — é exatamente esta opção que a seção existe pra
              // dizer a quem não pode mudar. Sem isto, a tela de quem só
              // acompanha não mostra qual regra vale.
              "cursor-not-allowed border-primary/60 bg-primary/5"
            : "cursor-not-allowed border-border opacity-60"
          : marcado
            ? "cursor-pointer border-primary bg-primary/5"
            : "cursor-pointer border-border hover:bg-muted/40"
      }`}
    >
      <input
        id={id}
        type="radio"
        name="modo-nascimento"
        value={valor}
        checked={marcado}
        disabled={disabled}
        onChange={() => onPick(valor)}
        // O nome acessível fica SÓ o título — a descrição chega pelo
        // `aria-describedby`, não pelo texto todo do `<label>` que envolve os
        // dois. Sem o `aria-label`, um leitor de tela anunciaria título e
        // descrição juntos como se fossem o nome da opção.
        aria-label={titulo}
        aria-describedby={descricaoId}
        className="mt-1 h-4 w-4 shrink-0 accent-primary"
      />
      <span className="space-y-1">
        <span className="block text-sm font-medium">
          {titulo}
          {emVigor ? (
            <span className="ml-2 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
              {t("Em vigor")}
            </span>
          ) : null}
        </span>
        <span id={descricaoId} className="block text-xs text-muted-foreground">
          {corpo}
        </span>
      </span>
    </label>
  );
}

export function NascimentoDoCard({ inicial, podeEditar }: { inicial: Regra; podeEditar: boolean }) {
  const t = useT();
  const router = useRouter();
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const [modo, setModo] = useState<ModoDeNascimentoDoCard>(inicial.modo);
  const [limiar, setLimiar] = useState<number>(inicial.limiar);
  const [semChaveOpenRouter, setSemChaveOpenRouter] = useState(false);
  const [salvando, iniciar] = useTransition();
  const mudou = modo !== inicial.modo || limiar !== inicial.limiar;
  const bloqueado = !podeEditar || salvando;

  function salvar() {
    setSemChaveOpenRouter(false);
    iniciar(async () => {
      const r = await definirNascimentoDoCard({ modo, limiar });
      if (r.ok) {
        toast.success(t("Regra salva."));
        // Foco pro título da seção: sem isto o foco fica no botão Salvar que
        // acabou de desabilitar (mudou volta a `false`) ou, quando a página
        // remonta pela `key` nova de `SecaoNascimentoDoCard`, cai no `body` —
        // o navegador não tem mais pra onde levar o foco que a remontagem
        // derrubou.
        tituloRef.current?.focus({ preventScroll: true });
        return;
      }
      toast.error(t(MENSAGEM_DO_ERRO[r.erro]));
      if (r.erro === "sem_chave_openrouter") setSemChaveOpenRouter(true);
      // A leitura fresca vem pela `key` nova que `SecaoNascimentoDoCard` monta
      // a partir do `inicial` atualizado — este componente só pede o refresh.
      if (r.erro === "tente_de_novo") router.refresh();
    });
  }

  return (
    <Card className="space-y-6 p-6" data-testid="nascimento-do-card">
      <div>
        <h2 ref={tituloRef} id={TITULO_ID} tabIndex={-1} className="text-base font-semibold outline-hidden">
          {t("Quando o card nasce")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("Decide quais conversas abrem um card.")}</p>
      </div>

      <fieldset className="space-y-2" aria-labelledby={TITULO_ID}>
        <Opcao
          id="nascimento-toda-conversa"
          descricaoId="nascimento-toda-conversa-desc"
          valor="toda_conversa"
          atual={modo}
          titulo={t("Toda conversa vira card")}
          corpo={t("A primeira mensagem de quem não tem card abre um card.")}
          onPick={setModo}
          disabled={bloqueado}
          podeEditar={podeEditar}
        />
        <Opcao
          id="nascimento-classificador"
          descricaoId="nascimento-classificador-desc"
          valor="classificador"
          atual={modo}
          titulo={t("Só conversas comerciais")}
          corpo={t(
            "A cada mensagem de quem ainda não tem card, a IA decide se o assunto é contratação, mudança de plano ou conhecer planos. Suporte, financeiro e cancelamento não contam como comerciais.",
          )}
          onPick={setModo}
          disabled={bloqueado}
          podeEditar={podeEditar}
        />
      </fieldset>

      {modo === "classificador" ? (
        <div className="space-y-1">
          <Label htmlFor="limiar-classificador">{t("Certeza mínima para abrir o card")}</Label>
          <Select value={String(limiar)} onValueChange={(v) => setLimiar(Number(v))} disabled={bloqueado}>
            <SelectTrigger id="limiar-classificador" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMIARES_DO_CLASSIFICADOR.map((l) => (
                <SelectItem key={l} value={String(l)}>
                  {Math.round(l * 100)}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t(
              "Mais alto abre menos cards por engano, mas pode deixar passar uma venda. Se a IA não conseguir responder, o card nasce assim mesmo e a linha do tempo diz por quê.",
            )}
          </p>
          {semChaveOpenRouter ? (
            // SEM `role="alert"`: o toast já anuncia o mesmo texto quando o
            // erro chega — um `alert` aqui faria um leitor de tela ouvir a
            // mesma frase duas vezes. Isto fica como texto comum, só lido
            // por quem navega até o card.
            <p data-testid="aviso-sem-chave-openrouter" className="text-xs text-amber-700 dark:text-amber-300">
              {t("Cadastre e valide uma chave da OpenRouter em IA › Credenciais antes de ligar esta regra.")}{" "}
              <Link href="/app/ai/credentials" className="font-medium underline underline-offset-4">
                {t("Cadastrar uma chave")}
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      {podeEditar ? (
        <div className="flex sm:justify-end">
          <Button onClick={salvar} disabled={!mudou || salvando} className="w-full sm:w-auto">
            {salvando ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("Só um administrador pode mudar essa regra.")}</p>
      )}
    </Card>
  );
}

/**
 * O invólucro que a PÁGINA usa — nunca `NascimentoDoCard` direto.
 *
 * A `key` mora AQUI, não espalhada na chamada de quem monta a tela: sem ela,
 * um `rerender` com `inicial` novo (a regra mudou no servidor — outra aba, ou
 * o `router.refresh()` de cima depois de um "tente_de_novo") reaproveitaria a
 * MESMA instância de `NascimentoDoCard`, e o `useState` que guarda `modo`/
 * `limiar` só roda o inicializador na primeira montagem — o rádio continuaria
 * mostrando a escolha ANTIGA, e "Salvar" compararia contra um `inicial` que
 * já não é mais o valor em vigor. Trocar a `key` força o React a desmontar e
 * remontar, e só a remontagem reinicializa o estado a partir do `inicial`
 * novo. `NascimentoDoCard.test.tsx` prova isto num invólucro rerenderizado
 * SEM clique nenhum — só assim o teste mede a `key`, e não o clique.
 */
export function SecaoNascimentoDoCard(props: { inicial: Regra; podeEditar: boolean }) {
  return <NascimentoDoCard key={`${props.inicial.modo}:${props.inicial.limiar}`} {...props} />;
}
