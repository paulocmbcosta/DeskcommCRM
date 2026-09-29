"use client";
/**
 * O cartão da ElevenLabs em Credenciais de IA (desenho da fase 2, §6.1 e §7).
 *
 * A chave que dá voz ao telefone. Uma por organização: salvar de novo TROCA. A
 * rota (`PUT /api/v1/telefonia/voz/chave`, só admin) valida a chave listando as
 * vozes da conta antes de gravar, e a tela nunca a recebe de volta — só os 4
 * últimos dígitos. O campo não tem `name`: nem um envio nativo do formulário
 * (JavaScript ainda não carregado) a poria na URL.
 *
 * O ESTADO vem da linha da credencial na lista desta mesma tela
 * (`useCredentialsList`, a view `ai_provider_credentials_safe`), e não do GET de
 * `/telefonia/voz/chave`: aquele devolve só "cadastrada / 4 últimos / validada
 * em", sem o `id` que o "Testar" precisa e sem o MOTIVO do último teste. E o
 * motivo é o que este cartão lê: o `credentialStatus` genérico diz "Inválida"
 * sempre que há `validation_error`, mas o `revalidate` da chave de voz só zera
 * `validated_at` quando a ElevenLabs RECUSA a chave — fora do ar ou sem crédito,
 * a chave continua a certa, e pedir para trocá-la seria mandar a pessoa
 * consertar o que não quebrou.
 *
 * Toda leitura passa pela API: no navegador o cliente do Supabase consultaria
 * como anônimo (cookie httpOnly) e voltaria vazio, sem erro.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { CHAVE_DA_VOZ } from "@/components/connections/telefone/api";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { credentialsListQueryKey, useCredentialsList, type CredentialRow } from "@/hooks/ai/useCredentials";
import { useT } from "@/hooks/i18n/useT";
import { ehLinhaDaChaveDeVoz } from "@/lib/ai/pontos/provedores";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { ehFalhaDaFala, MENSAGEM_DA_FALHA_DA_FALA, type MotivoDoErroDaElevenLabs } from "@/lib/telefonia/vocabulario";
import { ArrowsClockwise, Key } from "@/lib/ui/icons";

/**
 * A chave de voz é a linha deste provider COM este rótulo — o MESMO critério
 * (`ehLinhaDaChaveDeVoz`, em `lib/ai/pontos/provedores.ts`, client-safe) que
 * `estadoDaChaveDeVoz`/`chaveDeVoz` (`lib/telefonia/chave-elevenlabs.ts`)
 * passam para a consulta SQL. Um único predicado: antes, o rótulo "ElevenLabs"
 * vivia duplicado (uma cópia ali, outra solta aqui).
 */
const ehChaveDeVoz = ehLinhaDaChaveDeVoz;

type EstadoDaChave =
  | "nao_cadastrada"
  | "validada"
  | "nao_testada"
  | "recusada"
  | "fora_do_ar"
  | "sem_credito"
  | "outra_falha";

/**
 * O motivo do último teste → o estado do cartão. `Record` fechado: um motivo
 * novo da ElevenLabs não compila sem decidir o que a tela diz dele.
 */
const ESTADO_DO_MOTIVO: Record<MotivoDoErroDaElevenLabs, EstadoDaChave> = {
  chave_invalida: "recusada",
  sem_credito: "sem_credito",
  sem_resposta: "fora_do_ar",
  erro_do_provedor: "fora_do_ar",
  // A ElevenLabs pediu para esperar (429): não está fora do ar nem recusou a
  // chave. A frase certa é a própria mensagem do motivo.
  limite_de_uso: "outra_falha",
  // Listando vozes, estes dois praticamente não acontecem; se acontecerem, a
  // mensagem do motivo diz o que foi.
  texto_recusado: "outra_falha",
  voz_inexistente: "outra_falha",
};

function estadoDaChave(c: CredentialRow | null): EstadoDaChave {
  if (!c) return "nao_cadastrada";
  const motivo = c.validation_error;
  if (motivo) {
    return Object.hasOwn(ESTADO_DO_MOTIVO, motivo)
      ? ESTADO_DO_MOTIVO[motivo as MotivoDoErroDaElevenLabs]
      : "outra_falha";
  }
  return c.validated_at ? "validada" : "nao_testada";
}

const ROTULO_DO_ESTADO: Record<EstadoDaChave, string> = {
  nao_cadastrada: "Não cadastrada",
  validada: "Validada",
  nao_testada: "Não validada",
  recusada: "Chave recusada",
  fora_do_ar: "ElevenLabs fora do ar",
  sem_credito: "Sem crédito",
  outra_falha: "Falha no teste",
};

const VARIANTE_DO_ESTADO: Record<EstadoDaChave, "default" | "secondary" | "destructive" | "outline"> = {
  nao_cadastrada: "outline",
  validada: "default",
  nao_testada: "outline",
  recusada: "destructive",
  fora_do_ar: "secondary",
  sem_credito: "destructive",
  outra_falha: "secondary",
};

/** O que cada estado quer dizer para quem opera. `outra_falha` usa a mensagem do próprio motivo. */
const FRASE_DO_ESTADO: Record<Exclude<EstadoDaChave, "outra_falha">, string> = {
  nao_cadastrada:
    "Nenhuma chave cadastrada. Sem ela, o telefone não gera as falas do menu, do aguarde e do fora do horário.",
  validada: "A ElevenLabs aceitou esta chave.",
  nao_testada: "Esta chave ainda não foi testada.",
  recusada:
    "A ElevenLabs recusou esta chave no último teste. Sem uma chave aceita não dá para gerar falas novas; as já geradas continuam tocando.",
  fora_do_ar:
    "A ElevenLabs não respondeu ao último teste. A chave continua guardada e as falas já geradas continuam tocando; teste de novo mais tarde.",
  sem_credito:
    "A conta da ElevenLabs está sem crédito. As falas já geradas continuam tocando; para gerar falas novas, recarregue a conta.",
};

/**
 * A recusa do SALVAR, pelo código da rota. Nesses casos a chave colada NÃO foi
 * guardada (a rota só grava chave que passou no teste), e a frase precisa dizer
 * isso; a mensagem genérica da rota manda "conferir a chave em Credenciais de
 * IA" — que é esta tela. Código que não está aqui mostra a mensagem da rota.
 */
type RecusaConhecida = Extract<
  MotivoDoErroDaElevenLabs,
  "chave_invalida" | "sem_credito" | "sem_resposta" | "erro_do_provedor" | "limite_de_uso"
>;

const FRASE_DA_RECUSA_AO_SALVAR: Record<RecusaConhecida, string> = {
  chave_invalida:
    "A ElevenLabs recusou a chave, e ela não foi salva. Confira se copiou a chave inteira, ou gere uma nova na sua conta da ElevenLabs.",
  sem_credito:
    "A conta desta chave está sem crédito na ElevenLabs, e ela não foi salva. Recarregue a conta e salve de novo.",
  sem_resposta: "A ElevenLabs não respondeu, e a chave não foi salva. Tente de novo em instantes.",
  erro_do_provedor: "A ElevenLabs devolveu um erro, e a chave não foi salva. Tente de novo em instantes.",
  // 429 da PRÓPRIA ElevenLabs ao listar as vozes para validar a chave (não é a
  // cota NOSSA de prévias, que nem chega aqui): a mensagem genérica do motivo
  // ("pediu para esperar um pouco") não diz que a chave colada foi descartada.
  limite_de_uso: "A ElevenLabs recusou por limite de uso da conta, e a chave não foi salva. Tente de novo mais tarde.",
};

function ehRecusaConhecida(codigo: string): codigo is RecusaConhecida {
  return Object.hasOwn(FRASE_DA_RECUSA_AO_SALVAR, codigo);
}

interface Props {
  /** As linhas de `ai_provider_credentials_safe` que a página já leu no servidor. */
  credenciaisIniciais: CredentialRow[];
  /** Só admin cadastra, troca ou testa — a mesma régua das rotas. */
  podeEditar: boolean;
}

export function CartaoElevenLabs({ credenciaisIniciais, podeEditar }: Props) {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useCredentialsList({ initialData: credenciaisIniciais });
  const [chave, setChave] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  const credencial = (data ?? []).find(ehChaveDeVoz) ?? null;
  const estado = estadoDaChave(credencial);
  const motivo = credencial?.validation_error ?? null;

  // Um motivo que NEM `ehFalhaDaFala` reconhece (código novo da ElevenLabs, ou
  // legado de um clone) não pode aparecer cru na tela — "(unknown_provider)"
  // não ajuda quem opera, e o código nunca deveria vazar pela interface. A
  // frase genérica não leva o valor de `motivo`.
  const frase =
    estado !== "outra_falha"
      ? t(FRASE_DO_ESTADO[estado])
      : motivo && ehFalhaDaFala(motivo)
        ? t(MENSAGEM_DA_FALHA_DA_FALA[motivo])
        : t("Não foi possível confirmar o resultado deste teste. Tente de novo em instantes.");

  const salvar = useMutation({
    // A chave vai no corpo desta chamada e só nela: não é `variables` da
    // mutação (que o cache do react-query guardaria) nem parâmetro de URL.
    mutationFn: async () => apiClient.put<unknown>("/api/v1/telefonia/voz/chave", { chave }),
    onSuccess: async () => {
      setChave("");
      setErro(null);
      toast.success(t("Chave da ElevenLabs salva e validada."));
      await Promise.all([
        qc.invalidateQueries({ queryKey: credentialsListQueryKey }),
        // A aba Voz e falas (Conexões › Telefone) lê a chave para dizer se dá
        // para gerar as falas. A constante é a da própria aba: uma cópia da
        // chave de cache escrita aqui deixaria de reler no dia em que ela mudar.
        qc.invalidateQueries({ queryKey: CHAVE_DA_VOZ }),
      ]);
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        setErro(ehRecusaConhecida(e.code) ? t(FRASE_DA_RECUSA_AO_SALVAR[e.code]) : e.message);
      } else {
        setErro(t("Não foi possível salvar a chave. Tente de novo."));
      }
    },
  });

  const testar = useMutation({
    // Responde 200 com `validation_error` para a chave de voz: o motivo volta na
    // própria linha, e é dela que o estado do cartão sai.
    mutationFn: async (id: string) =>
      (await apiClient.post<{ data: CredentialRow }>(`/api/v1/ai/credentials/${id}/revalidate`, {})).data,
    onSuccess: async (linha) => {
      qc.setQueryData<CredentialRow[]>(credentialsListQueryKey, (lista) =>
        lista?.map((c) => (c.id === linha.id ? linha : c)),
      );
      if (!linha.validation_error) toast.success(t("A ElevenLabs aceitou a chave."));
      await qc.invalidateQueries({ queryKey: credentialsListQueryKey });
    },
    onError: (e) => showApiError(e),
  });

  const rotuloDoCampo = credencial ? t("Trocar a chave") : t("Chave da ElevenLabs");

  return (
    <section className="space-y-2" data-cartao-elevenlabs>
      <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Key size={16} aria-hidden /> {t("ElevenLabs (voz da URA)")}
      </h2>
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="font-medium">{t("Chave da ElevenLabs")}</h3>
            {credencial ? (
              <p className="font-mono text-xs text-muted-foreground" data-chave-de-voz-last4>
                {`…${credencial.api_key_last4 ?? "????"}`}
              </p>
            ) : null}
          </div>
          <Badge variant={VARIANTE_DO_ESTADO[estado]} className="shrink-0 text-xs" data-estado-da-chave={estado}>
            {t(ROTULO_DO_ESTADO[estado])}
          </Badge>
        </div>

        <p className="text-sm text-muted-foreground">
          {t(
            "A chave que dá voz ao telefone: o menu, o aguarde, o fora do horário e o aviso de instabilidade. Uma por organização. Ela é validada listando as vozes da sua conta, e nunca mais aparece na tela.",
          )}
        </p>

        <p
          aria-live="polite"
          className={
            VARIANTE_DO_ESTADO[estado] === "destructive" ? "text-sm text-destructive" : "text-sm text-foreground"
          }
        >
          {frase}
        </p>

        {!podeEditar ? (
          <p className="text-xs text-muted-foreground">
            {t("Só um administrador cadastra, troca ou testa esta chave.")}
          </p>
        ) : null}

        {podeEditar && credencial ? (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={testar.isPending || salvar.isPending}
              onClick={() => testar.mutate(credencial.id)}
            >
              <ArrowsClockwise size={14} aria-hidden className="mr-2" />
              {testar.isPending ? t("Testando…") : t("Testar")}
            </Button>
          </div>
        ) : null}

        {podeEditar ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              salvar.mutate();
            }}
          >
            <div className="min-w-[12rem] flex-1 space-y-1.5">
              <Label htmlFor="chave-elevenlabs">{rotuloDoCampo}</Label>
              <Input
                id="chave-elevenlabs"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={chave}
                onChange={(e) => {
                  setChave(e.target.value);
                  if (erro) setErro(null);
                }}
                aria-invalid={erro !== null}
                aria-describedby={erro ? "chave-elevenlabs-erro" : undefined}
              />
            </div>
            <Button type="submit" disabled={chave.trim().length < 8 || salvar.isPending || testar.isPending}>
              {salvar.isPending ? t("Validando…") : t("Salvar chave")}
            </Button>
            {erro ? (
              <p id="chave-elevenlabs-erro" role="alert" className="w-full text-sm text-destructive">
                {erro}
              </p>
            ) : null}
          </form>
        ) : null}
      </Card>
    </section>
  );
}
