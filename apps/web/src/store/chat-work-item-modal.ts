// Shell-level WorkItemDetailModal mount for chat-opened rich links. Lets a
// click on a `pc://work-item/<id>` pill open the modal over whichever tab
// the user is on. Distinct from KanbanBoard's local modal-open state — both
// modals can technically be open at once (acceptable v1 trade-off; user has
// to actively click in two places to trigger it).

import { create } from 'zustand';

interface ChatWorkItemModalState {
  workItemId: string | null;
  open: (id: string) => void;
  close: () => void;
}

export const useChatWorkItemModal = create<ChatWorkItemModalState>((set) => ({
  workItemId: null,
  open: (id) => set({ workItemId: id }),
  close: () => set({ workItemId: null }),
}));
