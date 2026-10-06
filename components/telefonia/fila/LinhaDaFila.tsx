"use client";
/**
 * UMA LIGAÇÃO VIVA na aba Telefone do Inbox (migration 0295): quem liga, para
 * qual time, por qual número da empresa, e ONDE ela está agora — na fila (com a
 * posição e o quanto falta para a espera esgotar), tocando para alguém, no menu
 * ou em ligação.
 *
 * A linha não lê relógio nenhum: `agoraMs` vem de quem a desenha, que é quem
 * sabe a defasagem entre o relógio do banco e o deste navegador. Assim as linhas
 * andam todas no mesmo segundo, e o teste não precisa esperar.
 *
 * É um botão só quando há o que abrir (`onAbrir`): a ligação de número oculto
 * não tem conversa, e uma linha que parece clicável e não faz nada é o controle
 * decorativo que esta casa não aceita.
 */
import { useT } from "@/hooks/i18n/useT";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { relogio, urgenciaDaEspera, type LigacaoNaFila, type UrgenciaDaEspera } from "@/lib/telefonia/fila";
import { Phone } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  ligacao: LigacaoNaFila;
  nomeDoTime: string | null;
  /** O número da EMPRESA que foi chamado (ou o apelido dele, quando não há número). */
  numeroDaEmpresa: string | null;
  /** A espera máxima do time, em segundos — a régua do peso da espera. */
  tetoS: number | null;
  /** O relógio do banco, já corrigido pela defasagem (ms). */
  agoraMs: number;
  selecionada: boolean;
  /** Abre a conversa da ligação. Ausente = a ligação não tem conversa, e a linha não é botão. */
  onAbrir?: () => void;
}

/** As mesmas medidas da linha de conversa (`ConversationListItem`): as duas listas dividem a coluna. */
const LINHA = "group relative flex w-full items-start gap-3 border-b border-border/70 px-3 py-2.5 text-left";
const LINHA_QUE_ABRE =
  "transition-colors hover:bg-surface-elevated focus-visible:outline-hidden focus-visible:bg-surface-elevated";

/**
 * A cor da espera na fila. Texto E cor: o tempo está sempre escrito, a cor só
 * diz o quanto ele pesa contra o teto do time.
 */
const COR_DA_URGENCIA: Record<UrgenciaDaEspera, string> = {
  normal: "text-text-muted",
  atencao: "rounded-full bg-warning-bg px-1.5 py-0.5 text-warning-fg",
  critico: "rounded-full bg-error px-1.5 py-0.5 text-bg",
};

/** Quanto tempo passou desde `iso`, em ms. Data ilegível conta zero, em vez de virar `NaN:NaN` na tela. */
function desde(iso: string | null, agoraMs: number): number {
  if (!iso) return 0;
  const ms = agoraMs - new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** O estado da ligação, por extenso, e o peso da espera (só a fila sem ninguém tocando tem prazo). */
function estadoDaLigacao(
  l: LigacaoNaFila,
  agoraMs: number,
  tetoS: number | null,
  t: (texto: string) => string,
): { texto: string; urgencia: UrgenciaDaEspera | null } {
  const naFilaHa = relogio(desde(l.na_fila_desde ?? l.entrou_em, agoraMs));
  switch (l.fase) {
    case "aguardando": {
      const caiEm = l.cai_em ? new Date(l.cai_em).getTime() : null;
      const prazo = caiEm !== null && Number.isFinite(caiEm) ? caiEm : null;
      const espera = `${t("Aguardando há")} ${naFilaHa}`;
      return {
        // Prazo vencido não vira "cai em 0:00" parado na tela: a cor já diz que
        // esgotou, e quem derruba a ligação é o worker.
        texto: prazo !== null && prazo > agoraMs ? `${espera} · ${t("cai em")} ${relogio(prazo - agoraMs)}` : espera,
        urgencia: urgenciaDaEspera(prazo, agoraMs, tetoS),
      };
    }
    case "tocando":
      return {
        texto: `${t("Tocando para")} ${l.tocando_para?.nome?.trim() || t("alguém")} · ${t("na fila há")} ${naFilaHa}`,
        urgencia: null,
      };
    case "menu":
      return { texto: `${t("Ouvindo as opções")} · ${relogio(desde(l.entrou_em, agoraMs))}`, urgencia: null };
    case "avisos":
      return { texto: `${t("Ouvindo os avisos")} · ${relogio(desde(l.entrou_em, agoraMs))}`, urgencia: null };
    case "em_ligacao":
      return {
        texto: `${t("Com")} ${l.com?.nome?.trim() || t("alguém")} ${t("há")} ${relogio(desde(l.atendida_em ?? l.entrou_em, agoraMs))}`,
        urgencia: null,
      };
    case "transferencia_na_fila":
      return {
        texto: `${t("Transferida por")} ${l.com?.nome?.trim() || t("alguém")} · ${t("aguardando há")} ${naFilaHa}`,
        urgencia: null,
      };
  }
}

export function LinhaDaFila({ ligacao, nomeDoTime, numeroDaEmpresa, tetoS, agoraMs, selecionada, onAbrir }: Props) {
  const t = useT();
  const nome = ligacao.contato?.nome?.trim() || null;
  const numero = phoneForDisplay(ligacao.numero) || null;
  const empresa = phoneForDisplay(numeroDaEmpresa) || null;
  // Com nome, o número desce para a segunda linha; sem nome, ele É o título.
  const detalhes = [nome ? numero : null, nomeDoTime, empresa ? `${t("pelo")} ${empresa}` : null].filter(Boolean);
  const estado = estadoDaLigacao(ligacao, agoraMs, tetoS, t);

  const conteudo = (
    <>
      {selecionada && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />}
      {/* Largura fixa: com a posição ou com o ícone, o nome começa no mesmo lugar. */}
      <span className="flex h-5 w-6 shrink-0 items-center justify-center">
        {ligacao.posicao !== null ? (
          <span
            className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent-soft px-1 text-[10px] font-medium tabular-nums text-accent"
            aria-label={`${t("Posição")} ${ligacao.posicao} ${t("na fila")}`}
          >
            {ligacao.posicao}º
          </span>
        ) : (
          <Phone size={14} className="text-text-subtle" aria-hidden />
        )}
      </span>
      <span className="block min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text">
          {nome ?? numero ?? t("Número não identificado")}
        </span>
        {detalhes.length > 0 && (
          <span className="mt-0.5 block truncate text-[11px] text-text-muted">{detalhes.join(" · ")}</span>
        )}
        <span className="mt-1 block text-[11px] font-medium">
          <span
            className={cn("inline-block max-w-full tabular-nums", COR_DA_URGENCIA[estado.urgencia ?? "normal"])}
            data-testid="estado-da-ligacao"
            data-urgencia={estado.urgencia ?? undefined}
          >
            {estado.texto}
          </span>
        </span>
      </span>
    </>
  );

  if (!onAbrir) {
    return (
      <div className={LINHA} data-ligacao-id={ligacao.id} data-fase={ligacao.fase}>
        {conteudo}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={cn(LINHA, LINHA_QUE_ABRE, selecionada && "bg-accent-50 hover:bg-accent-50")}
      data-ligacao-id={ligacao.id}
      data-fase={ligacao.fase}
      aria-current={selecionada ? "true" : undefined}
      onClick={onAbrir}
    >
      {conteudo}
    </button>
  );
}
