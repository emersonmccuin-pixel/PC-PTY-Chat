// Ask card — clickable-pick UI for claude.exe AskUserQuestion / ExitPlanMode
// intercepts. The same card renders for both the orchestrator chat and any
// transient session (workflow-creator, agent-creator) that wants to use
// AskUserQuestion. Behavior is purely in-component; routing of `ask` envelopes
// and `ask-reply` outbound messages stays at the parent.
//
// Extracted from Orchestrator.tsx with no behavioral changes.

import { useState } from 'react';

export interface AskCardProps {
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
  answered?: string;
  onReply: (answer: string) => void;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export function AskCard({ toolName, toolInput, answered, onReply }: AskCardProps) {
  const input = (toolInput ?? {}) as { plan?: string; questions?: AskQuestion[] };
  const isPlan = toolName === 'ExitPlanMode';
  const questions = input.questions ?? [];
  const isMulti = !isPlan && questions.length > 1;

  // Staged picks for the multi-question path (index → chosen label).
  // Single-question path keeps fire-on-click: no staging buffer needed.
  const [picks, setPicks] = useState<Record<number, string>>({});

  function reply(answer: string) {
    if (answered) return;
    onReply(answer);
  }

  function submitMulti() {
    if (answered) return;
    // Pack as JSON so the orchestrator sees one line per question.
    // Format chosen for readability inside the deny-reason string:
    //   [{"question":"X","answer":"A"}, {"question":"Y","answer":"B"}]
    const payload = questions.map((q, i) => ({
      question: q.question,
      answer: picks[i] ?? '',
    }));
    onReply(JSON.stringify(payload));
  }

  const canSubmitMulti =
    isMulti && questions.every((_, i) => picks[i] !== undefined);

  return (
    <div className="text-sm">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-accent">
        {isPlan
          ? 'Plan ready — review:'
          : isMulti
            ? `Claude is asking ${questions.length} questions:`
            : 'Claude is asking:'}
      </div>

      {isPlan ? (
        <>
          <pre className="mb-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words border border-border bg-background p-2 font-mono text-xs">
            {input.plan ?? '(no plan text)'}
          </pre>
          <div className="flex flex-col gap-2">
            {['approve', 'reject'].map((value) => (
              <button
                key={value}
                type="button"
                disabled={!!answered}
                onClick={() => reply(value)}
                className={
                  'self-start border border-border bg-background px-3 py-1 text-xs uppercase tracking-wider hover:bg-muted hover:text-foreground disabled:opacity-50 ' +
                  (answered === value ? 'border-primary text-primary' : 'text-foreground')
                }
              >
                {value === 'approve' ? 'Approve' : 'Reject'}
              </button>
            ))}
          </div>
        </>
      ) : questions.length === 0 ? (
        <div className="mb-2 text-sm italic text-muted-foreground">
          (no questions in payload — sending empty answer)
        </div>
      ) : isMulti ? (
        <div className="flex flex-col gap-4">
          {questions.map((q, qIdx) => {
            const picked = picks[qIdx];
            return (
              <div key={qIdx} className="flex flex-col gap-2 border-l border-border pl-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs uppercase tracking-wider text-muted-foreground">
                    Q{qIdx + 1}
                    {q.header ? ` · ${q.header}` : ''}
                  </span>
                  {picked ? (
                    <span className="bg-success px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-background">
                      picked
                    </span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wider text-warning">
                      pick one
                    </span>
                  )}
                </div>
                <div className="text-sm text-foreground">
                  {q.question || '(blank question)'}
                </div>
                <div className="flex flex-col gap-2">
                  {(q.options ?? []).map((opt) => {
                    const selected = picked === opt.label;
                    return (
                      <div key={opt.label} className="flex flex-col gap-0.5">
                        <button
                          type="button"
                          disabled={!!answered}
                          onClick={() =>
                            setPicks((prev) => ({ ...prev, [qIdx]: opt.label }))
                          }
                          className={
                            'self-start border px-3 py-1 text-xs uppercase tracking-wider disabled:opacity-50 ' +
                            (selected
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border bg-background text-foreground hover:bg-muted hover:text-foreground')
                          }
                        >
                          {selected ? '✓ ' : ''}
                          {opt.label}
                        </button>
                        {opt.description && (
                          <div className="ml-1 text-xs text-muted-foreground">
                            {opt.description}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Picks-so-far summary so the user sees exactly what's about to be submitted. */}
          <div className="border border-border bg-background/50 px-2 py-1.5">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              your answers
            </div>
            <ul className="flex flex-col gap-0.5 text-xs">
              {questions.map((_q, qIdx) => {
                const picked = picks[qIdx];
                return (
                  <li key={qIdx} className="flex items-baseline gap-1.5">
                    <span className="text-muted-foreground">Q{qIdx + 1}:</span>
                    {picked ? (
                      <span className="text-foreground">{picked}</span>
                    ) : (
                      <span className="italic text-warning/80">(not picked yet)</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : (
        // Single question — fast-path click-to-submit.
        <>
          <div className="mb-2 text-sm text-foreground">
            {questions[0]!.question || '(blank question)'}
          </div>
          <div className="flex flex-col gap-2">
            {(questions[0]!.options ?? []).map((opt) => {
              const selected = answered === opt.label;
              return (
                <div key={opt.label} className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    disabled={!!answered}
                    onClick={() => reply(opt.label)}
                    className={
                      'self-start border px-3 py-1 text-xs uppercase tracking-wider disabled:opacity-50 ' +
                      (selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background text-foreground hover:bg-muted hover:text-foreground')
                    }
                  >
                    {selected ? '✓ ' : ''}
                    {opt.label}
                  </button>
                  {opt.description && (
                    <div className="ml-1 text-xs text-muted-foreground">{opt.description}</div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-border pt-2">
        {isMulti && (
          <button
            type="button"
            disabled={!!answered || !canSubmitMulti}
            onClick={submitMulti}
            title={canSubmitMulti ? 'Submit all answers' : 'Pick an option for every question first'}
            className="bg-primary px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Submit{canSubmitMulti ? ` ${Object.keys(picks).length} answer${Object.keys(picks).length === 1 ? '' : 's'}` : ''}
          </button>
        )}
        <button
          type="button"
          disabled={!!answered}
          onClick={() => reply('__cancelled__')}
          title="Decline to answer — orchestrator gets a deny reason and can proceed differently."
          className={
            'border border-border bg-background px-3 py-1 text-xs uppercase tracking-wider hover:bg-muted hover:text-foreground disabled:opacity-50 ' +
            (answered === '__cancelled__' ? 'border-primary text-primary' : 'text-muted-foreground')
          }
        >
          Cancel
        </button>
      </div>

      {answered && (
        <div className="mt-2 text-xs text-muted-foreground">
          Answered: <span className="break-words text-foreground">{answered}</span>
        </div>
      )}
    </div>
  );
}
