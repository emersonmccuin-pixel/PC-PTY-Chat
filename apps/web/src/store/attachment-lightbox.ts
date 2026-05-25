// Shell-level <AttachmentLightbox> mount state. A rich-link click for a
// `pc://attachment/<id>` pill opens the lightbox over the current tab.

import { create } from 'zustand';

interface AttachmentLightboxState {
  attachmentId: string | null;
  open: (id: string) => void;
  close: () => void;
}

export const useAttachmentLightbox = create<AttachmentLightboxState>((set) => ({
  attachmentId: null,
  open: (id) => set({ attachmentId: id }),
  close: () => set({ attachmentId: null }),
}));
