"use client";

/**
 * O QUE A JANELA DE ENCERRAMENTO EXIGE — a superfície de
 * `settings.atendimento.encerramento` (migration 0293).
 *
 * Mora em Distribuição de atendimento porque é daqui a pergunta "o que quem
 * atende precisa registrar antes de encerrar?". Os dois interruptores nascem
 * desligados: a janela aparece para todo mundo, e só bloqueia quando a
 * organização decide.
 *
 * Quem APLICA a regra é o banco (`fn_atendimento_encerrar`). Esta tela só
 * guarda a escolha — e diz, sem rodeio, o caso em que ligar não muda nada:
 * "exigir o assunto" sem nenhum assunto cadastrado.
 */
import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirEncerramento, type ErroDoEncerramento } from "@/app/actions/settings/definirEncerramento";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { RESUMO_MINIMO } from "@/lib/atendimento/encerramento";
import type { EncerramentoDoAtendimento } from "@/lib/schemas/settings";

const MENSAGEM_DO_ERRO: Record<ErroDoEncerramento, string> = {
  invalido: "Não entendi essa escolha. Recarregue a página e tente de novo.",
  sessao: "Sua sessão expirou. Entre de novo.",
  somente_leitura: "Acompanhamento somente leitura ou encerrado.",
  sem_empresa: "Nenhuma empresa ativa.",
  sem_permissao: "Só gestor ou administrador pode mudar essa regra.",
  mfa: "Confirme a verificação em duas etapas.",
  tente_de_novo: "Outra pessoa mudou esta configuração agora. Confira e salve de novo.",
  falha: "Não consegui salvar essa mudança agora.",
};

export function EncerramentoForm({
  inicial,
  assuntosAtivos,
}: {
  inicial: EncerramentoDoAtendimento;
  /** Quantos assuntos ativos a organização tem — `null` se a contagem falhou. */
  assuntosAtivos: number | null;
}) {
  const t = useT();
  const router = useRouter();
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const [regra, setRegra] = useState<EncerramentoDoAtendimento>(inicial);
  const [salvando, iniciar] = useTransition();

  const mudou = regra.exigir_assunto !== inicial.exigir_assunto || regra.exigir_resumo !== inicial.exigir_resumo;

  function salvar() {
    iniciar(async () => {
      const r = await definirEncerramento(regra);
      if (r.ok) {
        toast.success(t("Regra de encerramento salva."));
        tituloRef.current?.focus({ preventScroll: true });
        router.refresh();
        return;
      }
      toast.error(t(MENSAGEM_DO_ERRO[r.erro]));
      if (r.erro === "tente_de_novo") router.refresh();
    });
  }

  return (
    <Card className="max-w-2xl space-y-5 p-6" data-testid="regra-de-encerramento">
      <div>
        <h2 ref={tituloRef} tabIndex={-1} className="text-base font-semibold outline-hidden">
          {t("Ao encerrar um atendimento")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Ao clicar em Fechar, quem atende informa o assunto e escreve um resumo do que foi tratado. O registro fica no histórico do cliente e alimenta os números por assunto em Métricas. Aqui você decide o que é obrigatório.",
          )}
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <Switch
            id="exigir-assunto"
            data-testid="exigir-assunto"
            checked={regra.exigir_assunto}
            disabled={salvando}
            onCheckedChange={(v) => setRegra((r) => ({ ...r, exigir_assunto: v }))}
          />
          <div className="space-y-1">
            <Label htmlFor="exigir-assunto">{t("Exigir o assunto")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("Ninguém encerra sem escolher o assunto. Os assuntos são cadastrados por time.")}{" "}
              <Link href="/app/settings/teams" className="font-medium text-accent hover:underline">
                {t("Cadastrar assuntos")}
              </Link>
            </p>
            {/* O caso em que ligar não muda nada, dito na hora — e não descoberto
                um mês depois, num painel de Métricas vazio. */}
            {regra.exigir_assunto && assuntosAtivos === 0 && (
              <p role="status" className="text-sm text-warning-fg" data-testid="aviso-sem-assuntos">
                {t("Ainda não há nenhum assunto cadastrado: nada será exigido até você cadastrar o primeiro.")}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-start gap-3">
          <Switch
            id="exigir-resumo"
            data-testid="exigir-resumo"
            checked={regra.exigir_resumo}
            disabled={salvando}
            onCheckedChange={(v) => setRegra((r) => ({ ...r, exigir_resumo: v }))}
          />
          <div className="space-y-1">
            <Label htmlFor="exigir-resumo">{t("Exigir o resumo")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("Ninguém encerra sem escrever o que foi tratado.")} {t("Mínimo de")} {RESUMO_MINIMO} {t("letras.")}
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={salvar} disabled={!mudou || salvando} data-testid="salvar-regra-de-encerramento">
          {salvando ? t("Salvando…") : t("Salvar regra")}
        </Button>
      </div>
    </Card>
  );
}
