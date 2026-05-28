import { postJson } from '@/api/http';
import type { ULID } from '@/features/projects/client';

export const transientSessionsApi = {
  startAgentDesigner: (projectId: ULID) =>
    postJson<{ ok: true; state: string; sessionId: string | null }>(
      `/api/projects/${projectId}/agent-designer/start`,
      {},
    ).then((r) => ({ state: r.state, sessionId: r.sessionId })),

  sendAgentDesigner: (projectId: ULID, text: string) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/agent-designer/send`, {
      text,
    }),

  interruptAgentDesigner: (projectId: ULID) =>
    postJson<{ ok: true }>(
      `/api/projects/${projectId}/agent-designer/interrupt`,
      {},
    ),

  sendAgentDesignerTerminalInput: (projectId: ULID, data: string) =>
    postJson<{ ok: true; bytesWritten: number }>(
      `/api/projects/${projectId}/agent-designer/terminal-input`,
      { data },
    ),

  resizeAgentDesigner: (projectId: ULID, cols: number, rows: number) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/agent-designer/resize`, {
      cols,
      rows,
    }),

  stopAgentDesigner: async (projectId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/agent-designer`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`stop agent-designer → ${res.status}`);
  },

  startSetupWizard: (projectId: ULID) =>
    postJson<{ ok: true; state: string; sessionId: string | null }>(
      `/api/projects/${projectId}/setup-wizard/start`,
      {},
    ).then((r) => ({ state: r.state, sessionId: r.sessionId })),

  sendSetupWizard: (projectId: ULID, text: string) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/setup-wizard/send`, { text }),

  interruptSetupWizard: (projectId: ULID) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/setup-wizard/interrupt`, {}),

  sendSetupWizardTerminalInput: (projectId: ULID, data: string) =>
    postJson<{ ok: true; bytesWritten: number }>(
      `/api/projects/${projectId}/setup-wizard/terminal-input`,
      { data },
    ),

  resizeSetupWizard: (projectId: ULID, cols: number, rows: number) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/setup-wizard/resize`, {
      cols,
      rows,
    }),

  stopSetupWizard: async (projectId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/setup-wizard`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`stop setup-wizard → ${res.status}`);
  },

  startWorkflowBuilder: (projectId: ULID) =>
    postJson<{ ok: true; state: string; sessionId: string | null }>(
      `/api/projects/${projectId}/workflow-builder/start`,
      {},
    ).then((r) => ({ state: r.state, sessionId: r.sessionId })),

  sendWorkflowBuilder: (projectId: ULID, text: string) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/workflow-builder/send`, { text }),

  interruptWorkflowBuilder: (projectId: ULID) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/workflow-builder/interrupt`, {}),

  sendWorkflowBuilderTerminalInput: (projectId: ULID, data: string) =>
    postJson<{ ok: true; bytesWritten: number }>(
      `/api/projects/${projectId}/workflow-builder/terminal-input`,
      { data },
    ),

  resizeWorkflowBuilder: (projectId: ULID, cols: number, rows: number) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/workflow-builder/resize`, {
      cols,
      rows,
    }),

  stopWorkflowBuilder: async (projectId: ULID): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/workflow-builder`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`stop workflow-builder → ${res.status}`);
  },

  saveWorkflowBuilderDraft: (
    projectId: ULID,
    sessionId: string,
    def: unknown,
  ) =>
    postJson<{ ok: true }>(`/api/projects/${projectId}/workflow-builder/draft`, {
      sessionId,
      def,
    }),
};
