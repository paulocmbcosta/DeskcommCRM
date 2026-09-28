"use client";
/**
 * "Ligar" numa conversa ou na ficha do contato (spec 20 §7). Liga pelo
 * telefone da empresa, para o número do cadastro do contato. Some quando a
 * organização não tem telefone; desabilita quando o ramal ainda não está
 * pronto ou já há uma ligação.
 */
import { useTelefonia } from "@/components/telefonia/TelefoniaContext";
import { Button } from "@/components/ui/button";
import { Phone } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  contatoId: string;
  nome?: string | null;
  temTelefone: boolean;
  /** `icone` para cabeçalho apertado (conversa); `completo` para a ficha do contato. */
  variante?: "icone" | "completo";
}

export function BotaoLigar({ contatoId, nome, temTelefone, variante = "completo" }: Props) {
  const { disponivel, pronto, ligacao, ligar } = useTelefonia();
  const t = useT();
  if (!disponivel || !temTelefone) return null;

  const ocupado = Boolean(ligacao);
  const rotulo = ocupado ? t("Em ligação") : pronto ? t("Ligar") : t("Telefone conectando");
  const acao = () => void ligar({ contatoId, nome: nome ?? null });

  if (variante === "icone") {
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label={rotulo}
        title={rotulo}
        disabled={!pronto || ocupado}
        onClick={acao}
        data-telefonia-ligar
      >
        <Phone size={18} aria-hidden />
      </Button>
    );
  }
  return (
    <Button variant="outline" className="shrink-0" disabled={!pronto || ocupado} onClick={acao} data-telefonia-ligar>
      <Phone size={16} weight="bold" aria-hidden />
      <span>{rotulo}</span>
    </Button>
  );
}
