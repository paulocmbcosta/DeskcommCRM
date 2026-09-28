import { describe, expect, it, vi } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { esperaPodeSerDispensada, processarEspera, type DependenciasDaEspera } from "./espera-da-assistente";

const AGORA = new Date("2026-09-26T10:01:00Z");
const ESPERA = "2026-09-26T10:00:00+00:00";

function evento(extra: Partial<EventRow> = {}): EventRow {
  return {
    id: "e1",
    organization_id: "org",
    entity_id: "msg",
    created_at: "2026-09-26T10:00:30Z",
    payload: { direction: "inbound", message_id: "msg", conversation_id: "conv", contact_id: "ct" },
    ...extra,
  } as unknown as EventRow;
}

function deps(over: Partial<DependenciasDaEspera> = {}, noul = 0.05): DependenciasDaEspera {
  return {
    espera: {
      conversa: vi.fn().mockResolvedValue({ espera_desde: ESPERA, last_inbound_at: ESPERA, espera_mantida_em: null, comando_da_conversa: "humano", status: "open" }),
      dispensar: vi.fn().mockResolvedValue(true),
    },
    mensagens: {
      mensagem: vi.fn().mockResolvedValue({ type: "text", media_derived_status: null }),
      ultimasMensagens: vi.fn().mockResolvedValue([
        { direcao: "outbound", texto: "assim que eu agendar te chamo" },
        { direcao: "inbound", texto: "ok obrigado" },
      ]),
      derivacaoPendente: vi.fn().mockResolvedValue(false),
    },
    chave: vi.fn().mockResolvedValue({ apiKey: "sk-or-teste", origem: "organizacao" }),
    consultar: vi.fn().mockResolvedValue({ ok: true, status: 200, latenciaMs: 300, corpo: { answers: { pede_resposta: { noul } } } }),
    registrarChamada: vi.fn(),
    agora: () => AGORA,
    ...over,
  } as unknown as DependenciasDaEspera;
}

describe("processarEspera", () => {
  it("'ok obrigado' depois de promessa: dispensa pela RPC, com a mensagem que disparou e o payload do evento", async () => {
    const d = deps();
    const r = await processarEspera(evento(), d);
    expect(r).toEqual({ status: "dispensada", probabilidade: 0.05 });
    expect(d.espera.dispensar).toHaveBeenCalledWith(
      "org",
      "conv",
      { espera_desde: ESPERA, last_inbound_at: ESPERA, mensagem_id: "msg" },
      expect.objectContaining({ probabilidade: 0.05, ate: ESPERA }),
    );
    expect(d.registrarChamada).toHaveBeenCalledTimes(1);
  });

  it("pede resposta: não dispensa", async () => {
    const d = deps({}, 0.9);
    expect(await processarEspera(evento(), d)).toEqual({ status: "pede_resposta", probabilidade: 0.9 });
    expect(d.espera.dispensar).not.toHaveBeenCalled();
  });

  it("sem espera, automático ou mantida por humano: não chama o Jev", async () => {
    for (const c of [
      { espera_desde: null, last_inbound_at: ESPERA, espera_mantida_em: null, comando_da_conversa: "humano", status: "open" },
      { espera_desde: ESPERA, last_inbound_at: ESPERA, espera_mantida_em: null, comando_da_conversa: "automatico", status: "open" },
      { espera_desde: ESPERA, last_inbound_at: ESPERA, espera_mantida_em: ESPERA, comando_da_conversa: "humano", status: "open" },
    ]) {
      const d = deps();
      (d.espera.conversa as ReturnType<typeof vi.fn>).mockResolvedValue(c);
      expect((await processarEspera(evento(), d)).status).toBe("pulado");
      expect(d.consultar).not.toHaveBeenCalled();
    }
  });

  it("sem chave: pula (a espera conta) ANTES de ler mensagens", async () => {
    const d = deps({ chave: vi.fn().mockResolvedValue(null) } as Partial<DependenciasDaEspera>);
    expect(await processarEspera(evento(), d)).toEqual({ status: "pulado", motivo: "sem_chave" });
    expect(d.mensagens.mensagem).not.toHaveBeenCalled();
    expect(d.mensagens.ultimasMensagens).not.toHaveBeenCalled();
    expect(d.consultar).not.toHaveBeenCalled();
  });

  it("áudio ainda sem transcrição: tenta de novo em 15 s", async () => {
    const d = deps();
    (d.mensagens.mensagem as ReturnType<typeof vi.fn>).mockResolvedValue({ type: "audio", media_derived_status: null });
    const r = await processarEspera(evento(), d);
    expect(r.status).toBe("tentar_de_novo");
  });

  it("falha temporária do Jev: tenta de novo; de conta: pula (conta)", async () => {
    const tmp = deps({ consultar: vi.fn().mockResolvedValue({ ok: false, latenciaMs: 1, falha: { tipo: "temporaria", status: 503, detalhe: "x" } }) } as Partial<DependenciasDaEspera>);
    expect((await processarEspera(evento(), tmp)).status).toBe("tentar_de_novo");
    const conta = deps({ consultar: vi.fn().mockResolvedValue({ ok: false, latenciaMs: 1, falha: { tipo: "conta", status: 401, detalhe: "x" } }) } as Partial<DependenciasDaEspera>);
    expect(await processarEspera(evento(), conta)).toEqual({ status: "pulado", motivo: "jev_falhou:conta" });
  });

  it("corrida (a RPC recusou: conversa mudou entre ler e gravar): pula", async () => {
    const d = deps();
    (d.espera.dispensar as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    expect(await processarEspera(evento(), d)).toEqual({ status: "pulado", motivo: "conversa_mudou" });
  });

  it("saída do atendente não é avaliada", async () => {
    const d = deps();
    const r = await processarEspera(evento({ payload: { direction: "outbound" } } as Partial<EventRow>), d);
    expect(r.status).toBe("pulado");
  });
});

describe("esperaPodeSerDispensada (predicado foraDaRequisicao)", () => {
  it("adia só quem espera gente, sem trava e com chave", async () => {
    const d = deps();
    expect(await esperaPodeSerDispensada(evento(), d)).toBe(true);
  });

  it("sem chave da OpenRouter não adia: o handler termina em skipped na requisição", async () => {
    const d = deps({ chave: vi.fn().mockResolvedValue(null) } as Partial<DependenciasDaEspera>);
    expect(await esperaPodeSerDispensada(evento(), d)).toBe(false);
  });

  it("conversa que não pode ser dispensada não adia e nem resolve a chave", async () => {
    const d = deps();
    (d.espera.conversa as ReturnType<typeof vi.fn>).mockResolvedValue({ espera_desde: null, last_inbound_at: ESPERA, espera_mantida_em: null, comando_da_conversa: "humano", status: "open" });
    expect(await esperaPodeSerDispensada(evento(), d)).toBe(false);
    expect(d.chave).not.toHaveBeenCalled();
  });

  it("falha ao ler NÃO adia (contrato do dispatcher: na dúvida roda na requisição)", async () => {
    const d = deps();
    (d.espera.conversa as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("banco fora"));
    expect(await esperaPodeSerDispensada(evento(), d)).toBe(false);
    const semChave = deps({ chave: vi.fn().mockRejectedValue(new Error("decifrar")) } as Partial<DependenciasDaEspera>);
    expect(await esperaPodeSerDispensada(evento(), semChave)).toBe(false);
  });

  it("a chave é resolvida UMA vez por evento: predicado e handler compartilham", async () => {
    const d = deps();
    const row = evento();
    expect(await esperaPodeSerDispensada(row, d)).toBe(true);
    expect((await processarEspera(row, d)).status).toBe("dispensada");
    expect(d.chave).toHaveBeenCalledTimes(1);
  });
});
