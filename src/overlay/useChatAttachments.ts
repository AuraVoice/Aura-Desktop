import { useCallback, useEffect, useRef, useState } from "react";
import {
  ATTACHMENT_ERRORS,
  prepareAttachment,
  validateAdd,
  type PendingAttachment,
} from "../lib/chatAttachments";
import { logError } from "../lib/log";

export interface ChatAttachmentsState {
  items: PendingAttachment[];
  /** The last refusal, shown under the composer until the next successful add
   * or an explicit dismiss. */
  error: string | null;
  /** True while a picked file is being decoded and encoded. */
  processing: boolean;
  addFiles: (files: FileList | File[]) => void;
  remove: (id: string) => void;
  /** Drops every pending row and its preview URL. `keepPreviews` hands the
   * object URLs over to the sent bubble instead of revoking them. */
  clear: (options?: { keepPreviews?: boolean }) => void;
  dismissError: () => void;
}

/** The composer's pending files. Validation runs on the File before any bytes
 * are read; a refused file leaves the earlier ones in place and reports why. */
export function useChatAttachments(): ChatAttachmentsState {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  // Adds are sequential so the count and total-size checks see every earlier
  // pick, including ones still being encoded.
  const itemsRef = useRef<PendingAttachment[]>([]);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const addFiles = useCallback((files: FileList | File[]) => {
    const picked = Array.from(files);
    if (picked.length === 0) return;
    setProcessing(true);
    queueRef.current = queueRef.current.then(async () => {
      for (const file of picked) {
        const refusal = validateAdd(itemsRef.current, file);
        if (refusal) {
          setError(refusal);
          continue;
        }
        try {
          const prepared = await prepareAttachment(file);
          itemsRef.current = [...itemsRef.current, prepared];
          setItems(itemsRef.current);
          setError(null);
        } catch (err) {
          logError("chat attachments: prepare", err);
          setError(ATTACHMENT_ERRORS.unreadable);
        }
      }
    }).finally(() => setProcessing(false));
  }, []);

  const remove = useCallback((id: string) => {
    const target = itemsRef.current.find((item) => item.id === id);
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
    itemsRef.current = itemsRef.current.filter((item) => item.id !== id);
    setItems(itemsRef.current);
  }, []);

  const clear = useCallback((options?: { keepPreviews?: boolean }) => {
    if (!options?.keepPreviews) {
      for (const item of itemsRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    }
    itemsRef.current = [];
    setItems([]);
    setError(null);
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  // Unmount (chat closed) drops whatever was never sent.
  useEffect(() => () => {
    for (const item of itemsRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
  }, []);

  return { items, error, processing, addFiles, remove, clear, dismissError };
}
