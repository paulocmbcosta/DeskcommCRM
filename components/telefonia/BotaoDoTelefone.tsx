"use client";
/**
 * O telefone no cabeçalho (spec 20 §7): o ponto verde diz se o ramal deste
 * navegador está pronto para receber ligação, e o clique abre o discador para
 * ligar para um número avulso. Organização sem telefone: não aparece.
 */
import { useState } from "react";

import { useTelefonia } from "@/components/telefonia/TelefoniaContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { MENSAGEM_DA_RECUSA, numeroParaLigar } from "@/lib/telefonia/numero";
import { Backspace, Phone } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

const TECLAS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

export function BotaoDoTelefone() {
  const { disponivel, pronto, numeros, ligacao, ligar } = useTelefonia();
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [digitado, setDigitado] = useState("");
  const [daEmpresa, setDaEmpresa] = useState<string | undefined>(undefined);

  if (!disponivel) return null;
  const conectados = numeros.filter((n) => n.conectado);
  const validacao = digitado.trim() ? numeroParaLigar(digitado) : null;
  const podeLigar = pronto && !ligacao && validacao?.ok === true;

  const discar = async () => {
    if (!podeLigar) return;
    setAberto(false);
    await ligar({ numero: digitado, numeroDaEmpresaId: daEmpresa ?? conectados[0]?.id });
    setDigitado("");
  };

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={pronto ? t("Telefone pronto") : t("Telefone conectando")}
          title={pronto ? t("Telefone pronto") : t("Telefone conectando")}
          data-telefonia-botao={pronto ? "pronto" : "conectando"}
        >
          <Phone size={18} aria-hidden />
          <span
            aria-hidden
            className={`absolute right-1.5 top-1.5 h-2 w-2 rounded-full ring-2 ring-background ${pronto ? "bg-emerald-500" : "bg-amber-400"}`}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void discar();
          }}
          className="space-y-3"
        >
          <div className="flex items-center gap-1">
            <Input
              autoFocus
              inputMode="tel"
              placeholder="(61) 99999-9999"
              value={digitado}
              onChange={(e) => setDigitado(e.target.value)}
              aria-label={t("Número para ligar")}
              className="text-base tabular-nums"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("Apagar")}
              onClick={() => setDigitado((v) => v.slice(0, -1))}
            >
              <Backspace size={18} aria-hidden />
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {TECLAS.map((k) => (
              <Button
                key={k}
                type="button"
                variant="outline"
                className="h-10 text-base tabular-nums"
                onClick={() => setDigitado((v) => v + k)}
              >
                {k}
              </Button>
            ))}
          </div>
          {conectados.length > 1 ? (
            <Select value={daEmpresa ?? conectados[0]?.id} onValueChange={setDaEmpresa}>
              <SelectTrigger aria-label={t("Ligar pelo número")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {conectados.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {n.nome ?? phoneForDisplay(n.numero ?? "")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {validacao && !validacao.ok ? (
            <p className="text-xs text-muted-foreground" role="status">
              {t(MENSAGEM_DA_RECUSA[validacao.motivo])}
            </p>
          ) : null}
          {!pronto ? (
            <p className="text-xs text-muted-foreground" role="status">
              {conectados.length === 0
                ? t("O número de telefone da empresa não está conectado agora.")
                : t("Conectando o telefone deste navegador…")}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={!podeLigar}>
            <Phone size={16} weight="bold" aria-hidden />
            <span>{t("Ligar")}</span>
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
