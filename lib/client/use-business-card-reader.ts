/**
 * 名刺の表（必須）と裏（任意）を選んでから、まとめて読み取る（本人登録と管理画面の共通。2026-10-02 ユーザー指示）。
 * 選んだ画像はブラウザの中だけで持ち、読み取りが終わったら手放す（保存しない）。
 */
import { useEffect, useRef, useState } from "react";
import type { BusinessCardResult } from "../business-card";
import { scanBusinessCard } from "./scan-business-card";

export type BusinessCardSide = "front" | "back";
export type PickedCardImage = { file: File; url: string };
type Picked = Record<BusinessCardSide, PickedCardImage | null>;
const NONE: Picked = { front: null, back: null };

/** apply: 読み取った値をフォームに入れ、画面に出す知らせを返す（結果が届いた時点の入力を見ること） */
export function useBusinessCardReader(apply: (card: BusinessCardResult) => string) {
  const [picked, setPicked] = useState<Picked>(NONE);
  const [state, setState] = useState<{ busy: boolean; message: string | null; error: string | null }>({ busy: false, message: null, error: null });
  const pickedRef = useRef(picked);
  const applyRef = useRef(apply);
  const alive = useRef(true);
  useEffect(() => { applyRef.current = apply; });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const image of Object.values(pickedRef.current)) if (image) URL.revokeObjectURL(image.url);
    };
  }, []);

  const replace = (next: Picked) => {
    for (const side of ["front", "back"] as const) {
      const old = pickedRef.current[side];
      if (old && old !== next[side]) URL.revokeObjectURL(old.url);
    }
    pickedRef.current = next;
    setPicked(next);
  };
  const pick = (side: BusinessCardSide, file: File | undefined) => {
    if (!file || state.busy) return;
    replace({ ...pickedRef.current, [side]: { file, url: URL.createObjectURL(file) } });
    setState({ busy: false, message: null, error: null });
  };
  const clear = (side: BusinessCardSide) => {
    if (!state.busy) replace({ ...pickedRef.current, [side]: null });
  };
  const read = async () => {
    const { front, back } = pickedRef.current;
    if (!front || state.busy) return;
    setState({ busy: true, message: null, error: null });
    const result = await scanBusinessCard(front.file, back?.file ?? null);
    if (!alive.current) return;
    if (result.kind === "error") {
      // 選んだ画像は残し、撮り直しや選び直しをしやすくする
      setState({ busy: false, message: null, error: result.message });
      return;
    }
    const message = applyRef.current(result.card);
    replace(NONE);
    setState({ busy: false, message, error: null });
  };
  return { picked, pick, clear, read, ...state };
}
