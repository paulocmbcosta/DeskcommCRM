"use client";
import { useHotkeys } from "react-hotkeys-hook";

interface Props {
  /** Currently visible conversation ids in the list (for j/k nav). */
  visibleIds: string[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onFocusReply: () => void;
  onClaim: () => void;
  onClose: () => void;
  onToggleHelp: () => void;
  enabled?: boolean;
}

export function InboxKeyboardShortcuts({
  visibleIds,
  selectedId,
  onSelect,
  onFocusReply,
  onClaim,
  onClose,
  onToggleHelp,
  enabled = true,
}: Props) {
  function step(delta: number) {
    if (visibleIds.length === 0) return;
    const idx = selectedId ? visibleIds.indexOf(selectedId) : -1;
    let next = idx + delta;
    if (idx < 0) next = delta > 0 ? 0 : visibleIds.length - 1;
    if (next < 0) next = 0;
    if (next >= visibleIds.length) next = visibleIds.length - 1;
    const id = visibleIds[next];
    if (id) onSelect(id);
  }

  useHotkeys("j", () => step(1), { enabled, preventDefault: true }, [
    visibleIds,
    selectedId,
  ]);
  useHotkeys("k", () => step(-1), { enabled, preventDefault: true }, [
    visibleIds,
    selectedId,
  ]);
  useHotkeys("r", () => onFocusReply(), { enabled, preventDefault: true });
  useHotkeys("a", () => onClaim(), { enabled, preventDefault: true });
  // `e` ABRE a janela de encerramento (migration 0293) — a mesma do botão
  // "Fechar". Era um `confirm()` do navegador que fechava na hora.
  useHotkeys("e", () => onClose(), { enabled, preventDefault: true });
  useHotkeys("shift+/", () => onToggleHelp(), { enabled, preventDefault: true });

  return null;
}
