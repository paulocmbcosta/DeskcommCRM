"use client";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type OfficialChannel,
  useConnectOfficialChannel,
  useOfficialChannel,
} from "@/hooks/channels/useOfficialChannel";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/hooks/i18n/useT";
import { ChannelAiAccess } from "./ChannelAiAccess";

/** Campo somente-leitura com botão de copiar — o que o operador cola na Meta. */
function ParaColar({
  rotulo,
  valor,
  semValor,
}: {
  rotulo: string;
  valor: string | null;
  /** O que dizer quando não há valor para mostrar — que nem sempre é "falta configurar". */
  semValor?: React.ReactNode;
}) {
  const t = useT();
  if (!valor) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {rotulo}
        </span>
        {semValor}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {rotulo}
      </span>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">{valor}</code>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await copyToClipboard(valor);
            toast.success(t("Copiado."));
          }}
        >
          {t("Copiar")}
        </Button>
      </div>
    </div>
  );
}

/** O que o operador cola na Meta para UM número — cada número tem a sua URL. */
function ColarNaMeta({ webhook }: { webhook: OfficialChannel["webhook"] }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      <div>
        <h3 className="text-sm font-medium">{t("Cole isto no painel da Meta")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Em")} <strong>WhatsApp → {t("Configuração")}</strong>
          {t(", na seção de Webhook. Sem esse passo o canal envia, mas")}{" "}
          <strong>{t("não recebe")}</strong>
          {t(" — as respostas do cliente não chegam e a janela de 24 horas nunca abre.")}
        </p>
      </div>
      <ParaColar rotulo={t("URL de callback")} valor={webhook.callbackUrl} />
      <ParaColar
        rotulo={t("Token de verificação")}
        valor={webhook.verifyToken}
        semValor={
          // Desde a 0257 o token vive na tela de administração da instalação
          // e é mostrado UMA vez, quando é gerado. Mandar "definir no
          // servidor" quem já cadastrou tudo por lá seria mandá-lo editar um
          // arquivo que ele não precisa abrir — e o valor do arquivo nem é
          // mais o que a Meta precisa receber.
          <span className="flex flex-col items-start gap-1">
            {webhook.verifyTokenOrigem === "instalacao" ? (
              <span className="text-sm text-muted-foreground" data-testid="token-na-instalacao">
                {t("Já cadastrado na administração da instalação. Ele aparece uma vez só, quando é gerado — se não foi guardado, quem administra a instalação gera outro em Admin › API Oficial (Meta).")}
              </span>
            ) : (
              <span className="text-sm text-destructive" data-testid="token-nao-configurado">
                {t("Ainda não configurado. Quem administra a instalação cadastra em Admin › API Oficial (Meta), e o token aparece lá pronto para copiar.")}
              </span>
            )}
            {webhook.configurarEm ? (
              <Link
                href={webhook.configurarEm}
                data-testid="abrir-app-da-meta"
                className="text-sm font-medium underline underline-offset-2"
              >
                {t("Abrir API Oficial (Meta) na administração")}
              </Link>
            ) : null}
          </span>
        }
      />
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("Campos a assinar")}
        </span>
        <div className="flex flex-wrap gap-1">
          {webhook.fields.map((f) => (
            <Badge key={f} variant="outline" className="font-mono text-xs">
              {f}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}

const FORM_VAZIO = { phone_number_id: "", waba_id: "", token: "", app_secret: "", app_id: "" };

export function CanalOficialClient() {
  const t = useT();
  const { data, isPending } = useOfficialChannel();
  const conectar = useConnectOfficialChannel();
  const [form, setForm] = useState(FORM_VAZIO);
  /**
   * O número cuja credencial está sendo trocada — `null` é "conectar um número
   * novo". O `phone_number_id` é a chave do canal: com ele, o servidor atualiza
   * aquele número; com outro, cria um canal novo ao lado.
   */
  const [trocando, setTrocando] = useState<OfficialChannel | null>(null);

  const canais = data?.data.channels ?? [];

  function trocarCredencial(canal: OfficialChannel) {
    setTrocando(canal);
    setForm({
      ...FORM_VAZIO,
      phone_number_id: canal.phoneNumberId ?? "",
      waba_id: canal.wabaId ?? "",
    });
    document.getElementById("form-canal-oficial")?.scrollIntoView({ behavior: "smooth" });
  }

  function voltarAoNovo() {
    setTrocando(null);
    setForm(FORM_VAZIO);
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    const r = await conectar.mutateAsync(form);
    toast.success(`${t("Conectado:")} ${r.data.displayName} ${r.data.phoneNumber ?? ""}`.trim());
    // Os segredos somem do formulário assim que gravam — deixá-los na tela seria
    // mantê-los em memória do navegador sem motivo, e eles não voltam em nenhum GET.
    voltarAoNovo();
  }

  if (isPending) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;

  const tituloDoForm = trocando
    ? `${t("Trocar credencial")} · ${trocando.phoneNumber ?? trocando.displayName ?? ""}`.trim()
    : canais.length > 0
      ? t("Adicionar outro número")
      : t("Conectar canal oficial");

  return (
    <div className="flex flex-col gap-4" data-testid="canal-oficial-root">
      {canais.map((canal) => (
        <Card key={canal.channel_session_id} className="flex flex-col gap-3 p-4" data-testid="canal-conectado">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{canal.displayName}</span>
            {canal.phoneNumber ? (
              <Badge variant="outline" className="font-mono text-xs">
                {canal.phoneNumber}
              </Badge>
            ) : null}
            <Badge>{canal.status ?? "—"}</Badge>
            {/* Mostra que o token EXISTE, nunca qual é. */}
            <Badge variant={canal.hasToken ? "outline" : "destructive"}>
              {canal.hasToken ? t("credencial guardada") : t("sem credencial")}
            </Badge>
            {canal.hasOwnAppSecret ? (
              <Badge variant="outline" data-testid="app-proprio">
                {t("app da Meta próprio")}
              </Badge>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => trocarCredencial(canal)}
              data-testid="btn-trocar-credencial"
            >
              {t("Trocar credencial")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            WABA <span className="font-mono">{canal.wabaId}</span> · {t("número")}{" "}
            <span className="font-mono">{canal.phoneNumberId}</span>
          </p>
          <ChannelAiAccess channelId={canal.channel_session_id} />
          <ColarNaMeta webhook={canal.webhook} />
        </Card>
      ))}

      <Card className="p-4" id="form-canal-oficial">
        <h2 className="font-medium" data-testid="titulo-form-oficial">
          {tituloDoForm}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Os três valores vêm do seu app na Meta (")}
          <strong>WhatsApp → {t("Configuração da API")}</strong>
          {t("). A credencial é")} <strong>{t("validada com a Meta antes de ser gravada")}</strong>
          {t(" — se o número não responder, nada é salvo.")}
        </p>
        {!trocando && canais.length > 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Um número novo vira uma caixa de entrada nova, ao lado das que já existem — nenhuma é substituída.")}
          </p>
        ) : null}

        <form onSubmit={enviar} className="mt-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pnid">{t("ID do número de telefone")}</Label>
            <Input
              id="pnid"
              value={form.phone_number_id}
              onChange={(e) => setForm((f) => ({ ...f, phone_number_id: e.target.value }))}
              placeholder="1103328999528818"
              // Trocando a credencial, o número é a chave do canal: mudá-lo aqui
              // criaria um canal novo em vez de trocar a credencial deste.
              readOnly={trocando !== null}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="waba">{t("ID da conta do WhatsApp Business")}</Label>
            <Input
              id="waba"
              value={form.waba_id}
              onChange={(e) => setForm((f) => ({ ...f, waba_id: e.target.value }))}
              placeholder="2434045433735175"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tok">{t("Token de acesso")}</Label>
            <Input
              id="tok"
              type="password"
              value={form.token}
              onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
              placeholder={
                trocando?.hasToken ? t("•••• (já guardado — preencha para trocar)") : "EAAG…"
              }
              required
            />
            <span className="text-xs text-muted-foreground">
              {t("Guardado cifrado. Não é exibido de volta em nenhum momento.")}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="appsecret">
              {t("Chave secreta do app (opcional)")}
            </Label>
            <Input
              id="appsecret"
              type="password"
              value={form.app_secret}
              onChange={(e) => setForm((f) => ({ ...f, app_secret: e.target.value }))}
              placeholder={
                trocando?.hasOwnAppSecret ? t("•••• (já guardada — preencha para trocar)") : ""
              }
              data-testid="campo-app-secret"
            />
            <span className="text-xs text-muted-foreground">
              {t("Só se este número pertence a um app da Meta diferente do cadastrado na instalação. Sem ela, as mensagens desse número chegam e são recusadas. Fica em Configurações do app › Básico › Chave secreta do app.")}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="appid">{t("ID do app do webhook (opcional)")}</Label>
            <Input
              id="appid"
              inputMode="numeric"
              value={form.app_id}
              onChange={(e) => setForm((f) => ({ ...f, app_id: e.target.value }))}
              placeholder="690936200035931"
              data-testid="campo-app-id"
            />
            <span className="text-xs text-muted-foreground">
              {t("Preencha quando o token acima foi gerado em um app e o webhook deste número vem de outro. A chave secreta é conferida com este app.")}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={conectar.isPending} data-testid="btn-conectar">
              {conectar.isPending ? t("Validando com a Meta…") : t("Validar e conectar")}
            </Button>
            {trocando ? (
              <Button type="button" variant="ghost" onClick={voltarAoNovo}>
                {t("Cancelar")}
              </Button>
            ) : null}
          </div>
        </form>
      </Card>
    </div>
  );
}
