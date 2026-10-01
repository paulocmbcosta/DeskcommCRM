"use client";
/**
 * O telefone no cabeçalho (spec 20 §7): o ponto verde diz se o ramal deste
 * navegador está pronto para receber ligação, e o clique abre o discador para
 * ligar para um número avulso. Organização sem telefone: não aparece.
 *
 * v3 (ramais, D18): o discador mostra "Seu ramal: 201" e aceita o ramal de um
 * colega (2 a 4 dígitos) ou o nome dele — sugerindo quem casa, com a situação
 * de agora; só quem está disponível pode ser chamado (D17).
 */
import { useMemo, useState } from "react";

import { useTelefonia } from "@/components/telefonia/TelefoniaContext";
import { ROTULO_DA_SITUACAO, casaComABusca, useDiretorio } from "@/components/telefonia/useDiretorio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { alvoDoDiscador } from "@/lib/telefonia/discador";
import { MENSAGEM_DA_RECUSA, numeroParaLigar } from "@/lib/telefonia/numero";
import { Backspace, Phone } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

const TECLAS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

export function BotaoDoTelefone() {
  const { disponivel, pronto, numeros, ligacao, ligar, meuRamal } = useTelefonia();
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [digitado, setDigitado] = useState("");
  const [daEmpresa, setDaEmpresa] = useState<string | undefined>(undefined);
  const alvo = alvoDoDiscador(digitado);
  // O diretório só é lido com o discador aberto e algo que pareça colega (ramal ou nome).
  const { diretorio } = useDiretorio(disponivel && aberto && (alvo.tipo === "ramal" || alvo.tipo === "nome"));
  const colegas = useMemo(
    () =>
      alvo.tipo === "nome" || alvo.tipo === "ramal"
        ? (diretorio?.pessoas ?? []).filter((p) => !p.eu && p.ramal && casaComABusca(p, alvo.tipo === "nome" ? alvo.busca : alvo.ramal)).slice(0, 6)
        : [],
    [diretorio, alvo],
  );

  if (!disponivel) return null;
  const conectados = numeros.filter((n) => n.conectado);
  const validacao = alvo.tipo === "numero" ? numeroParaLigar(digitado) : null;
  const colegaDoRamal = alvo.tipo === "ramal" ? colegas.find((c) => c.ramal === alvo.ramal) : undefined;
  const podeLigar =
    pronto &&
    !ligacao &&
    (alvo.tipo === "ramal" ? alvo.ramal !== meuRamal && colegaDoRamal?.situacao !== "offline" : validacao?.ok === true);

  const discar = async () => {
    if (!podeLigar) return;
    setAberto(false);
    if (alvo.tipo === "ramal") await ligar({ ramal: alvo.ramal, nome: colegaDoRamal?.nome ?? null });
    else await ligar({ numero: digitado, numeroDaEmpresaId: daEmpresa ?? conectados[0]?.id });
    setDigitado("");
  };

  const ligarParaColega = async (c: { ramal: string | null; nome: string }) => {
    if (!c.ramal || !pronto || ligacao) return;
    setAberto(false);
    await ligar({ ramal: c.ramal, nome: c.nome });
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
          {meuRamal ? (
            <p className="text-xs text-muted-foreground" data-telefonia-meu-ramal>
              {t("Seu ramal:")} <span className="font-semibold tabular-nums text-foreground">{meuRamal}</span>
            </p>
          ) : null}
          <div className="flex items-center gap-1">
            <Input
              autoFocus
              placeholder={t("Número, ramal ou nome")}
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
          {colegas.length > 0 ? (
            <ul className="space-y-1" data-telefonia-colegas>
              {colegas.map((c) => {
                const livre = c.situacao === "disponivel";
                return (
                  <li key={c.user_id}>
                    <button
                      type="button"
                      disabled={!livre || !pronto || Boolean(ligacao)}
                      onClick={() => void ligarParaColega(c)}
                      data-situacao={c.situacao}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                    >
                      <span className="min-w-0 truncate">
                        {c.nome} <span className="tabular-nums text-muted-foreground">{c.ramal}</span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{t(ROTULO_DA_SITUACAO[c.situacao])}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {alvo.tipo === "ramal" && alvo.ramal === meuRamal ? (
            <p className="text-xs text-muted-foreground" role="status">
              {t("Esse é o seu ramal.")}
            </p>
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
