"use client";

/**
 * 画像欄へのドラッグ＆ドロップ（2026-09-25 ユーザー指示）。ファイルを重ねているあいだ over を立て、落としたら 1 件目を渡す。
 * 欄の外に落としたファイルをブラウザが開いて、入力中の画面から離れてしまわないよう、欄を出しているあいだは
 * ページのほかの場所へのドロップも止める（カーソルは「置けない」の表示にする）。
 */
import { useEffect, useRef, useState, type DragEvent } from "react";

const hasFiles = (e: { dataTransfer: DataTransfer | null }) => Boolean(e.dataTransfer?.types.includes("Files"));

export function useFileDrop(onFile: (file: File) => void, disabled: boolean) {
  const [over, setOver] = useState(false);
  // 欄の中の子要素へ移るたびに dragenter・dragleave が対で来るので、入った深さで数える
  const depth = useRef(0);

  useEffect(() => {
    const block = (e: globalThis.DragEvent) => {
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      if (e.type === "dragover" && e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  const handlers = {
    onDragEnter: (e: DragEvent<HTMLElement>) => {
      if (!hasFiles(e) || disabled) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!hasFiles(e) || disabled) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!hasFiles(e) || disabled) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const file = e.dataTransfer.files[0];
      if (file) onFile(file);
    },
  };

  return { over, handlers };
}
