"use client";
/** O cartão de "telefonia desligada nesta instalação" — o mesmo nas três abas do Telefone. */
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";

export function TelefoniaDesligada() {
  const t = useT();
  return (
    <Card className="space-y-2 p-5" data-telefonia-desligada>
      <h2 className="text-base font-semibold">{t("Telefonia desligada nesta instalação")}</h2>
      <p className="text-sm text-muted-foreground">
        {t(
          "Para fazer e receber ligações pelo CRM, quem administra o servidor precisa ligar a telefonia (perfil “telefonia” do Docker Compose) e rodar a atualização. Depois disso, os números são cadastrados aqui.",
        )}
      </p>
    </Card>
  );
}
