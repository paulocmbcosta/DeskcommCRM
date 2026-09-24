"use client";

/**
 * A RÉGUA DO TERMÔMETRO — a superfície de `settings.inbox.regua_de_espera`.
 *
 * Mora em Distribuição de atendimento porque é daqui a pergunta "quanto tempo o
 * cliente pode esperar uma pessoa?". Sem esta tela, os degraus seriam constante
 * no código — e o que vale para uma clínica (minutos) não vale para uma
 * imobiliária.
 *
 * A validação da ordem (amarelo < laranja < vermelho) é a MESMA do servidor
 * (`reguaDeEsperaWriteSchema`): a tela recusa antes de mandar, e a action recusa
 * de novo se alguém mandar por fora.
 */
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirReguaDeEspera, type ErroReguaDeEspera } from "@/app/actions/settings/definirReguaDeEspera";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { REGUA_DE_ESPERA_PADRAO, reguaDeEsperaWriteSchema, type ReguaDeEspera } from "@/lib/schemas/settings";

const MENSAGEM_DO_ERRO: Record<ErroReguaDeEspera, string> = {
  invalido: "Use minutos inteiros, de 1 a 1440, crescendo do amarelo ao vermelho.",
  sessao: "Sua sessão expirou. Entre de novo.",
  somente_leitura: "Acompanhamento somente leitura ou encerrado.",
  sem_empresa: "Nenhuma empresa ativa.",
  sem_permissao: "Só gestor ou administrador pode mudar essa regra.",
  mfa: "Confirme a verificação em duas etapas.",
  tente_de_novo: "Outra pessoa mudou esta configuração agora. Confira e salve de novo.",
  falha: "Não consegui salvar essa mudança agora.",
};

const DEGRAUS = [
  { chave: "amarelo_min", rotulo: "Amarelo a partir de", cor: "bg-warning" },
  { chave: "laranja_min", rotulo: "Laranja a partir de", cor: "bg-alert" },
  { chave: "vermelho_min", rotulo: "Vermelho pulsando a partir de", cor: "bg-error" },
] as const;

export function ReguaDeEsperaForm({ inicial }: { inicial: ReguaDeEspera }) {
  const t = useT();
  const router = useRouter();
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const [valores, setValores] = useState<Record<keyof ReguaDeEspera, string>>({
    amarelo_min: String(inicial.amarelo_min),
    laranja_min: String(inicial.laranja_min),
    vermelho_min: String(inicial.vermelho_min),
  });
  const [salvando, iniciar] = useTransition();

  const candidata = {
    amarelo_min: Number(valores.amarelo_min),
    laranja_min: Number(valores.laranja_min),
    vermelho_min: Number(valores.vermelho_min),
  };
  const valida = reguaDeEsperaWriteSchema.safeParse(candidata);
  const mudou =
    candidata.amarelo_min !== inicial.amarelo_min ||
    candidata.laranja_min !== inicial.laranja_min ||
    candidata.vermelho_min !== inicial.vermelho_min;

  function salvar() {
    if (!valida.success) return;
    iniciar(async () => {
      const r = await definirReguaDeEspera(valida.data);
      if (r.ok) {
        toast.success(t("Régua salva."));
        tituloRef.current?.focus({ preventScroll: true });
        router.refresh();
        return;
      }
      toast.error(t(MENSAGEM_DO_ERRO[r.erro]));
      if (r.erro === "tente_de_novo") router.refresh();
    });
  }

  return (
    <Card className="max-w-2xl space-y-5 p-6" data-testid="regua-de-espera">
      <div>
        <h2 ref={tituloRef} tabIndex={-1} className="text-base font-semibold outline-hidden">
          {t("Termômetro de espera")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Quanto tempo o cliente pode ficar sem resposta de uma pessoa antes de o card mudar de cor no Inbox. Conta a partir da primeira mensagem dele que ninguém respondeu.",
          )}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {DEGRAUS.map((degrau) => (
          <div key={degrau.chave} className="space-y-1.5">
            <Label htmlFor={`regua-${degrau.chave}`} className="flex items-center gap-2">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${degrau.cor}`} aria-hidden />
              {t(degrau.rotulo)}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={`regua-${degrau.chave}`}
                type="number"
                inputMode="numeric"
                min={1}
                max={1440}
                step={1}
                value={valores[degrau.chave]}
                disabled={salvando}
                onChange={(e) => setValores((v) => ({ ...v, [degrau.chave]: e.target.value }))}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">{t("min")}</span>
            </div>
          </div>
        ))}
      </div>

      {!valida.success && (
        <p role="alert" className="text-sm text-error-fg">
          {t("Use minutos inteiros, de 1 a 1440, crescendo do amarelo ao vermelho.")}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={salvar} disabled={!valida.success || !mudou || salvando}>
          {salvando ? t("Salvando…") : t("Salvar régua")}
        </Button>
        <Button
          variant="ghost"
          disabled={salvando}
          onClick={() =>
            setValores({
              amarelo_min: String(REGUA_DE_ESPERA_PADRAO.amarelo_min),
              laranja_min: String(REGUA_DE_ESPERA_PADRAO.laranja_min),
              vermelho_min: String(REGUA_DE_ESPERA_PADRAO.vermelho_min),
            })
          }
        >
          {t("Voltar ao padrão (2 / 5 / 10)")}
        </Button>
      </div>
    </Card>
  );
}
