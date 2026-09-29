"use client";
/**
 * As faixas de estado do topo de /app EMPILHADAS num contêiner `sticky` só — o
 * acompanhamento administrativo, a conexão caída e o aviso de instabilidade do
 * telefone. Cada uma `sticky top-0` por conta própria, elas grudavam no MESMO
 * ponto ao rolar e a de cima cobria as outras. Dentro do contêiner, o `sticky`
 * de cada faixa não tem para onde andar (o pai tem a altura delas) e elas se
 * comportam como antes; quem gruda é o conjunto.
 *
 * O contêiner publica a própria altura em `--altura-das-faixas` no `<html>`
 * (`ResizeObserver`; 0 sem faixa nenhuma), e a TopBar e a Inbox descontam dela —
 * a conta mora em `lib/ui/faixas-do-topo.ts`.
 *
 * As faixas chegam como `children` do layout (servidor): este componente só mede.
 */
import { useEffect, useRef, type ReactNode } from "react";

import { VARIAVEL_DA_ALTURA_DAS_FAIXAS } from "@/lib/ui/faixas-do-topo";

export function FaixasDoTopo({ children }: { children: ReactNode }) {
  const caixa = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = caixa.current;
    if (!el) return;
    const raiz = document.documentElement;
    const publicar = (altura: number) =>
      raiz.style.setProperty(VARIAVEL_DA_ALTURA_DAS_FAIXAS, `${Math.max(0, Math.round(altura))}px`);
    publicar(el.getBoundingClientRect().height);
    const observador =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entradas) => {
            const e = entradas[0];
            if (e) publicar(e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height);
          });
    observador?.observe(el);
    return () => {
      observador?.disconnect();
      raiz.style.removeProperty(VARIAVEL_DA_ALTURA_DAS_FAIXAS);
    };
  }, []);

  return (
    <div ref={caixa} data-faixas-do-topo="" className="sticky top-0 z-50">
      {children}
    </div>
  );
}
