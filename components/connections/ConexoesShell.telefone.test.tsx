/**
 * AS SUB-ABAS DO TELEFONE EM CONEXÕES (desenho da fase 2, §6.2).
 *
 * `?aba=` já escolhe o canal, então a aba de dentro do Telefone mora em `?sub=`
 * (`menus` | `falas`; sem `sub` = Números). É para esses endereços que a Central
 * aponta (`lib/ai/inbox-destino.ts`: "uma fala não tocou" → `sub=falas`, menu com
 * time arquivado → `sub=menus`) — um link que abrisse em outra aba mandaria a
 * pessoa procurar de novo.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const nav = vi.hoisted(() => ({ busca: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.busca),
}));

vi.mock("./CanalOficialClient", () => ({ CanalOficialClient: () => null }));
vi.mock("./CanalParceiroClient", () => ({ CanalParceiroClient: () => null }));
vi.mock("./CanalVozClient", () => ({ CanalVozClient: () => null }));
vi.mock("./ChatDoSiteClient", () => ({ ChatDoSiteClient: () => null }));
vi.mock("./ConnectionsClient", () => ({ ConnectionsClient: () => null }));
vi.mock("./TemplatesClient", () => ({ TemplatesClient: () => null }));
vi.mock("./TemplatesParceiroClient", () => ({ TemplatesParceiroClient: () => null }));
vi.mock("./CanalTelefoneClient", () => ({ CanalTelefoneClient: () => <div data-aba-numeros /> }));
vi.mock("./telefone/MenusDoTelefone", () => ({ MenusDoTelefone: () => <div data-aba-menus /> }));
vi.mock("./telefone/VozEFalas", () => ({ VozEFalas: () => <div data-aba-falas /> }));

import { ConexoesShell } from "./ConexoesShell";

function pintar(busca: string) {
  nav.busca = busca;
  return render(<ConexoesShell wahaConfigured wacallsConfigured={false} />);
}

const aberta = () =>
  ["numeros", "menus", "falas"].filter((a) => document.querySelector(`[data-aba-${a}]`) !== null);

beforeEach(() => nav.replace.mockReset());
afterEach(() => cleanup());

describe("Conexões › Telefone — Números · Menus · Voz e falas", () => {
  it("sem `sub`, abre em Números (o que já existia)", () => {
    pintar("aba=telefone");
    expect(aberta()).toEqual(["numeros"]);
    expect(screen.getByRole("tab", { name: "Números" })).toHaveAttribute("aria-selected", "true");
  });

  it("o link da Central (`sub=falas`) abre direto em Voz e falas", () => {
    pintar("aba=telefone&sub=falas");
    expect(aberta()).toEqual(["falas"]);
  });

  it("o link da Central (`sub=menus`) abre direto em Menus", () => {
    pintar("aba=telefone&sub=menus");
    expect(aberta()).toEqual(["menus"]);
  });

  it("trocar de sub-aba escreve `?sub=` na URL; voltar a Números tira o `sub`", async () => {
    pintar("aba=telefone&sub=falas");
    await userEvent.click(screen.getByRole("tab", { name: "Menus" }));
    expect(nav.replace).toHaveBeenLastCalledWith("/app/connections?aba=telefone&sub=menus", { scroll: false });
    await userEvent.click(screen.getByRole("tab", { name: "Números" }));
    expect(nav.replace).toHaveBeenLastCalledWith("/app/connections?aba=telefone", { scroll: false });
  });

  it("`sub` de outro canal não abre sub-aba do Telefone", () => {
    pintar("aba=telefone&sub=templates");
    expect(aberta()).toEqual(["numeros"]);
  });
});
