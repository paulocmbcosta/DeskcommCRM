"use client";
/**
 * OS CAMPOS DE UM MODELO APROVADO — um por parâmetro, e o texto final antes do envio.
 *
 * ─── A lacuna que este componente fecha ─────────────────────────────────────
 *
 * O sistema inteiro já sabia mandar modelo COM valores: `template_values` existe
 * no schema de envio, o handler o repassa, `buildComponents` monta o payload e
 * `conferirDefinicao` confere o que falta ANTES de gastar. O que não existia era
 * quem preenchesse — nenhuma tela do produto coletava um único valor.
 *
 * O efeito prático era uma parede: o seletor da janela fechada enviava sempre
 * com `values: {}` e admitia no próprio comentário que "a plataforma recusa". E
 * como todo modelo de abertura carrega ao menos o nome de quem se está
 * chamando, começar conversa pelo canal oficial era impossível pela tela.
 *
 * ─── Por que a derivação roda AQUI, no browser ──────────────────────────────
 *
 * Porque é literalmente a mesma função pura que monta o payload no servidor.
 * `deriveTemplateContract` não tem um único `import` — foi escrita assim de
 * propósito, e o cabeçalho dela diz para que serve: "esta função é PURA e tem
 * DOIS consumidores: o formulário da tela e o montador do payload de envio".
 * Este arquivo é o primeiro consumidor, que faltava desde então.
 *
 * O ganho não é performance, é impossibilidade: com uma derivação só, o campo
 * que a tela mostra e o parâmetro que a plataforma recebe não têm como
 * discordar. Contar placeholder à mão aqui reabriria o 132000
 * ("number of parameters does not match") por outro caminho.
 *
 * ─── A chave vem pronta, e nunca é montada aqui ─────────────────────────────
 *
 * `slotKey(address, key)` endereça o SLOT, não a `key`: um carrossel de dois
 * cards tem dois slots com `key: '1'`, e chavear pela `key` faria o segundo
 * sobrescrever o primeiro em silêncio. Por isso o componente aceita a `chave`
 * já montada — pela rota, no servidor, ou pela mesma `slotKey` no cliente — e
 * nunca a constrói a partir de pedaços.
 */
import { useMemo } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

/** O que a tela precisa de um slot. Espelha `SlotParaTela` da rota de modelos. */
export interface CampoDoModelo {
  chave: string;
  key: string;
  expects: string;
  onde: string;
  contextoAntes: string;
  contextoDepois: string;
}

/**
 * Slots que pedem um endereço de arquivo, não um texto.
 *
 * A distinção muda o rótulo e o `placeholder` — pedir "o valor de {{1}}" para um
 * cabeçalho de imagem faria o operador digitar o nome do produto e receber 132012
 * ("Format mismatch, expected IMAGE"). O montador já sabe a diferença
 * (`parameterFor`); a tela precisa dizê-la em voz alta.
 */
const ESPERA_ARQUIVO = new Set(["image", "video", "document"]);

/** Rótulo legível de um slot: o texto ao redor é o que torna o campo preenchível. */
function rotuloDoCampo(campo: CampoDoModelo): string {
  const contexto = `${campo.contextoAntes}…${campo.contextoDepois}`.trim();
  // Sem contexto (slot de mídia, ou placeholder sozinho na linha) o rótulo cai
  // para o endereço. "Parâmetro 1" sozinho não ajuda ninguém a preencher — é
  // exatamente o que o contrato carrega `contextBefore`/`contextAfter` para evitar.
  if (contexto === "…") return `${campo.onde} · {{${campo.key}}}`;
  return contexto;
}

/**
 * O texto do modelo com os valores já aplicados.
 *
 * É a única resposta honesta para "o que o cliente vai ler?", e ela existe
 * porque o operador está escrevendo às cegas: ele preenche `{{1}}` sem ver a
 * frase em volta. Substitui só o que foi preenchido; o resto continua visível
 * como `{{n}}`, que é a forma de mostrar o que ainda falta sem uma segunda lista.
 */
export function aplicarValores(texto: string, valoresPorKey: Record<string, string>): string {
  return texto.replace(/\{\{(\w+)\}\}/g, (inteiro, key: string) => {
    const v = valoresPorKey[key];
    return v && v.trim() ? v : inteiro;
  });
}

export function CamposDoModelo({
  campos,
  valores,
  onChange,
  disabled,
}: {
  campos: CampoDoModelo[];
  /** Chaveado por `chave` (o `slotKey`), que é o formato de `template_values`. */
  valores: Record<string, string>;
  onChange: (valores: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const t = useT();

  // Agrupa por ONDE para que "cabeçalho", "corpo" e "botão 2" não virem uma
  // lista plana de campos sem hierarquia — num modelo com carrossel isso passa
  // de uma dúzia de entradas iguais.
  const grupos = useMemo(() => {
    const mapa = new Map<string, CampoDoModelo[]>();
    for (const campo of campos) {
      const lista = mapa.get(campo.onde) ?? [];
      lista.push(campo);
      mapa.set(campo.onde, lista);
    }
    return [...mapa.entries()];
  }, [campos]);

  if (campos.length === 0) return null;

  return (
    <div className="space-y-3">
      {grupos.map(([onde, doGrupo]) => (
        <div key={onde} className="space-y-2">
          {grupos.length > 1 && (
            <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
              {onde}
            </p>
          )}
          {doGrupo.map((campo) => {
            const arquivo = ESPERA_ARQUIVO.has(campo.expects);
            return (
              <div key={campo.chave} className="space-y-1">
                <Label htmlFor={`modelo-${campo.chave}`} className="text-xs font-normal">
                  <span className="text-text-muted">{`{{${campo.key}}}`}</span>{" "}
                  <span className="text-text">{rotuloDoCampo(campo)}</span>
                </Label>
                <Input
                  id={`modelo-${campo.chave}`}
                  value={valores[campo.chave] ?? ""}
                  disabled={disabled}
                  // `url` e não `text` para mídia: o teclado móvel muda e o
                  // browser valida o formato antes do envio sair.
                  type={arquivo ? "url" : "text"}
                  placeholder={
                    arquivo
                      ? t("https://… (link público do arquivo)")
                      : t("Valor que entra aqui")
                  }
                  onChange={(e) => onChange({ ...valores, [campo.chave]: e.target.value })}
                  className={cn("h-9 text-sm", !(valores[campo.chave] ?? "").trim() && "border-amber-300 dark:border-amber-800/60")}
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
