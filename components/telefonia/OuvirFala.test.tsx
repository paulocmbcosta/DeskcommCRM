/**
 * OUVIR UMA FALA SALVA E OUVIR A PRÉVIA (desenho da fase 2, §4 passo 2).
 *
 * O navegador não toca μ-law cru: os dois tocadores entregam ao `<audio>` um WAV
 * montado por `ulawParaWav` (44 bytes de cabeçalho + 2 bytes por amostra).
 *
 *  - `OuvirFala` baixa o áudio da fala SALVA só quando a pessoa pede ("Ouvir"):
 *    abrir a aba não baixa nada (o Storage do self-host é cota paga). Se a rota
 *    recusa, a tela mostra a frase DELA — "o áudio sumiu, gere a prévia de novo"
 *    pede uma ação diferente de "o Storage falhou, tente de novo".
 *  - `OuvirPrevia` toca o áudio que já está na memória da aba, sem rede, e avisa
 *    quem precisa saber que a pessoa ouviu.
 *  - Sair da tela no meio do download cancela o pedido e não cria `blob:`; sair
 *    depois de tocar revoga o `blob:` — nenhum fica vivo sem dono.
 *  - Cada `<audio>` tem o nome da sua fala: com três na tela, o leitor de tela
 *    precisa dizer qual é qual.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import { OuvirFala } from "./OuvirFala";
import { OuvirPrevia } from "./OuvirPrevia";

const blobs: Blob[] = [];
const fetchFalso = vi.fn();

beforeEach(() => {
  blobs.length = 0;
  fetchFalso.mockReset();
  vi.stubGlobal("fetch", fetchFalso);
  URL.createObjectURL = vi.fn((b: Blob) => {
    blobs.push(b);
    return `blob:teste/${blobs.length}`;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OuvirFala — o áudio da fala salva", () => {
  it("abrir não baixa nada; 'Ouvir' baixa o μ-law da rota e toca como WAV", async () => {
    fetchFalso.mockResolvedValue(new Response(new Uint8Array([0xff, 0x7f, 0x00]), { status: 200 }));
    render(<OuvirFala falaId="fala-1" />);
    expect(fetchFalso).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Ouvir/ }));
    expect(fetchFalso).toHaveBeenCalledWith(
      "/api/v1/telefonia/falas/fala-1/audio",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    const audio = await waitFor(() => {
      const el = document.querySelector('audio[data-fala-audio="fala-1"]');
      expect(el).not.toBeNull();
      return el as HTMLAudioElement;
    });
    expect(audio.getAttribute("src")).toBe("blob:teste/1");
    expect(blobs[0]?.type).toBe("audio/wav");
    expect(blobs[0]?.size).toBe(44 + 3 * 2);
  });

  it("o áudio sumiu (404 `audio_ausente`): a frase da rota, que diz para gerar a prévia de novo", async () => {
    const frase = "O áudio desta fala não foi encontrado. Gere a prévia de novo e salve.";
    fetchFalso.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "audio_ausente", message: frase } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<OuvirFala falaId="fala-2" />);
    await userEvent.click(screen.getByRole("button", { name: /Ouvir/ }));
    expect(await screen.findByText(frase)).toBeInTheDocument();
    expect(document.querySelector("audio")).toBeNull();
  });

  it("resposta sem corpo de erro (rede, proxy): uma frase genérica, e dá para tentar de novo", async () => {
    fetchFalso.mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }));
    render(<OuvirFala falaId="fala-3" />);
    await userEvent.click(screen.getByRole("button", { name: /Ouvir/ }));
    expect(await screen.findByText("Não foi possível carregar o áudio desta fala.")).toBeInTheDocument();

    fetchFalso.mockResolvedValueOnce(new Response(new Uint8Array([0xff]), { status: 200 }));
    await userEvent.click(screen.getByRole("button", { name: /Ouvir/ }));
    await waitFor(() => expect(document.querySelector('audio[data-fala-audio="fala-3"]')).not.toBeNull());
  });
});

describe("OuvirFala — sair da tela não deixa pedido nem blob: para trás", () => {
  it("desmontar no meio do download cancela o pedido, e a resposta que chega depois não vira blob:", async () => {
    let soltar: (r: Response) => void = () => undefined;
    fetchFalso.mockImplementation(
      () =>
        new Promise<Response>((res) => {
          soltar = res;
        }),
    );
    const { unmount } = render(<OuvirFala falaId="fala-4" />);
    await userEvent.click(screen.getByRole("button", { name: /Ouvir/ }));
    const sinal = (fetchFalso.mock.calls[0]?.[1] as RequestInit).signal as AbortSignal;
    expect(sinal.aborted).toBe(false);

    unmount();
    expect(sinal.aborted).toBe(true);
    soltar(new Response(new Uint8Array([0xff]), { status: 200 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("desmontar depois de tocar revoga o blob: criado", async () => {
    fetchFalso.mockResolvedValue(new Response(new Uint8Array([0xff]), { status: 200 }));
    const { unmount } = render(<OuvirFala falaId="fala-5" />);
    await userEvent.click(screen.getByRole("button", { name: /Ouvir/ }));
    await waitFor(() => expect(document.querySelector('audio[data-fala-audio="fala-5"]')).not.toBeNull());
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:teste/1");
  });
});

describe("os tocadores dizem de qual fala são", () => {
  it("o áudio salvo e o botão levam o nome da fala", async () => {
    fetchFalso.mockResolvedValue(new Response(new Uint8Array([0xff]), { status: 200 }));
    render(<OuvirFala falaId="fala-6" nome="Aguarde" />);
    await userEvent.click(screen.getByRole("button", { name: "Ouvir: Aguarde" }));
    expect(await screen.findByLabelText("Áudio salvo da fala: Aguarde")).toBeInstanceOf(HTMLAudioElement);
  });

  it("a prévia e o botão levam o nome da fala; sem nome, um rótulo genérico", () => {
    const { unmount } = render(<OuvirPrevia audio={new Uint8Array([0xff])} nome="Fora do horário" />);
    expect(screen.getByLabelText("Prévia da fala: Fora do horário")).toBeInstanceOf(HTMLAudioElement);
    expect(screen.getByRole("button", { name: "Ouvir: Fora do horário" })).toBeInTheDocument();
    unmount();
    render(<OuvirPrevia audio={new Uint8Array([0xff])} />);
    expect(screen.getByLabelText("Prévia da fala")).toBeInstanceOf(HTMLAudioElement);
  });
});

describe("os tocadores com um nome que traz `$&` ou `$\``: o rótulo sai literal", () => {
  it("OuvirFala", async () => {
    fetchFalso.mockResolvedValue(new Response(new Uint8Array([0xff]), { status: 200 }));
    render(<OuvirFala falaId="fala-7" nome="Ana $` X" />);
    await userEvent.click(screen.getByRole("button", { name: "Ouvir: Ana $` X" }));
    expect(await screen.findByLabelText("Áudio salvo da fala: Ana $` X")).toBeInstanceOf(HTMLAudioElement);
  });

  it("OuvirPrevia", () => {
    render(<OuvirPrevia audio={new Uint8Array([0xff])} nome="A$&B" />);
    expect(screen.getByLabelText("Prévia da fala: A$&B")).toBeInstanceOf(HTMLAudioElement);
    expect(screen.getByRole("button", { name: "Ouvir: A$&B" })).toBeInTheDocument();
  });
});

describe("OuvirPrevia — o áudio que está na memória da aba", () => {
  it("toca o WAV da prévia sem ir à rede, e 'Ouvir' avisa que a pessoa ouviu", async () => {
    const aoOuvir = vi.fn();
    render(<OuvirPrevia audio={new Uint8Array([0xff, 0xff])} aoOuvir={aoOuvir} />);
    await waitFor(() => expect(document.querySelector("audio[data-previa-audio]")?.getAttribute("src")).toBe("blob:teste/1"));
    expect(blobs[0]?.type).toBe("audio/wav");
    expect(blobs[0]?.size).toBe(44 + 2 * 2);
    expect(fetchFalso).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Ouvir/ }));
    expect(aoOuvir).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });
});
