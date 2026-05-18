// Hand-rolled workflow validator (Slice 9 M4). Parses an arbitrary YAML
// object into a typed Workflow with DagNode `kind` discriminators applied.
// Returns granular {path, message} errors. Recursive — same node validator
// runs against root `nodes:` and inside every `loop.body:`.
//
// Cross-checks deferred to dispatch (subagent file exists, stage_id matches
// a real stage, nested `workflow:` resolves) — keeps the validator's
// behavior predictable per file. The runtime surfaces those with clearer
// errors at dispatch time.

import { load as yamlLoad } from 'js-yaml';

import type {
  ApprovalNode,
  AttachToWorkItemNode,
  BashNode,
  CancelNode,
  CreateWorkItemNode,
  DagNode,
  DoneWhen,
  HttpNode,
  LoopNode,
  NestedWorkflowNode,
  OrchestratorReviewNode,
  RetryCause,
  RetryPolicy,
  ScriptNode,
  SubagentNode,
  TriggerRule,
  UpdateWorkItemNode,
  WriteToWorktreeNode,
  Workflow,
} from '@pc/domain';

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  workflow?: Workflow;
  errors: ValidationError[];
  /**
   * Best-effort extraction of the workflow's `triggers.on_enter.stage_id`,
   * populated even when the rest of the file is invalid. Lets the registry
   * distinguish "no file targets this stage" from "file targets but is broken".
   */
  partialStageId?: string;
}

const TRIGGER_RULES: ReadonlySet<TriggerRule> = new Set([
  'all_success',
  'one_success',
  'all_done',
  'none_failed_min_one_success',
]);

const TYPE_BODY_FIELDS = [
  'subagent',
  'bash',
  'http',
  'script',
  'approval',
  'cancel',
  'workflow',
  'loop',
  'attach-to-work-item',
  'create-work-item',
  'update-work-item',
  'write-to-worktree',
  'orchestrator-review',
] as const;

const HTTP_METHODS: ReadonlySet<HttpNode['http']['method']> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
]);

export function validateWorkflow(
  raw: unknown,
  opts: { expectedId: string },
): ValidationResult {
  const errors: ValidationError[] = [];
  const partialStageId = readPartialStageId(raw);

  if (!isObj(raw)) {
    errors.push({ path: '', message: 'workflow must be a YAML object' });
    return { ok: false, errors, partialStageId };
  }

  const obj = raw;

  // id
  let id = '';
  if (typeof obj.id !== 'string' || !obj.id) {
    errors.push({ path: 'id', message: 'must be a non-empty string' });
  } else if (obj.id !== opts.expectedId) {
    errors.push({
      path: 'id',
      message: `must match filename — file is "${opts.expectedId}.yaml" but id is "${obj.id}"`,
    });
  } else {
    id = obj.id;
  }

  // description (optional)
  if (obj.description !== undefined && typeof obj.description !== 'string') {
    errors.push({ path: 'description', message: 'must be a string if provided' });
  }

  // triggers (optional)
  const triggers = validateTriggers(obj.triggers, errors);

  // inputs / outputs (optional) — type-string maps (documentation only).
  const inputs = validateStringRecord(obj.inputs, 'inputs', errors);
  const outputs = validateStringRecord(obj.outputs, 'outputs', errors);

  // worktree (optional)
  if (
    obj.worktree !== undefined &&
    obj.worktree !== 'auto' &&
    obj.worktree !== 'none'
  ) {
    errors.push({
      path: 'worktree',
      message: 'must be "auto" or "none" if provided',
    });
  }

  // nodes (required)
  let nodes: DagNode[] | undefined;
  if (!Array.isArray(obj.nodes)) {
    errors.push({ path: 'nodes', message: 'must be an array' });
  } else if (obj.nodes.length === 0) {
    errors.push({ path: 'nodes', message: 'must contain at least one node' });
  } else {
    nodes = validateNodeArray(obj.nodes, 'nodes', errors);
  }

  if (errors.length || !nodes) {
    return { ok: false, errors, partialStageId };
  }

  const workflow: Workflow = {
    id,
    nodes,
  };
  if (typeof obj.description === 'string') workflow.description = obj.description;
  if (triggers) workflow.triggers = triggers;
  if (inputs) workflow.inputs = inputs;
  if (outputs) workflow.outputs = outputs;
  if (obj.worktree === 'auto' || obj.worktree === 'none') {
    workflow.worktree = obj.worktree;
  }

  return { ok: true, workflow, errors: [], partialStageId };
}

/** Parse + validate from raw YAML text. Used by the registry. */
export function parseWorkflowText(
  yamlText: string,
  opts: { expectedId: string },
): ValidationResult {
  let parsed: unknown;
  try {
    parsed = yamlLoad(yamlText);
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: '', message: `yaml parse failed: ${(err as Error).message}` }],
    };
  }
  return validateWorkflow(parsed, opts);
}

function validateTriggers(
  raw: unknown,
  errors: ValidationError[],
): Workflow['triggers'] | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) {
    errors.push({ path: 'triggers', message: 'must be an object if provided' });
    return undefined;
  }

  const out: NonNullable<Workflow['triggers']> = {};

  if (raw.on_enter !== undefined) {
    if (!isObj(raw.on_enter)) {
      errors.push({
        path: 'triggers.on_enter',
        message: 'must be an object with a stage_id',
      });
    } else if (typeof raw.on_enter.stage_id !== 'string' || !raw.on_enter.stage_id) {
      errors.push({
        path: 'triggers.on_enter.stage_id',
        message: 'must be a non-empty string',
      });
    } else {
      out.on_enter = { stage_id: raw.on_enter.stage_id };
    }
  }

  if (raw.callable !== undefined) {
    if (typeof raw.callable !== 'boolean') {
      errors.push({ path: 'triggers.callable', message: 'must be a boolean if provided' });
    } else {
      out.callable = raw.callable;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function validateNodeArray(
  rawArr: unknown[],
  basePath: string,
  errors: ValidationError[],
): DagNode[] | undefined {
  const seenIds = new Set<string>();
  const nodes: DagNode[] = [];

  rawArr.forEach((raw, i) => {
    const path = `${basePath}[${i}]`;
    if (!isObj(raw)) {
      errors.push({ path, message: 'must be an object' });
      return;
    }
    const node = validateNode(raw, path, errors);
    if (!node) return;
    if (seenIds.has(node.id)) {
      errors.push({ path: `${path}.id`, message: `duplicate node id "${node.id}"` });
      return;
    }
    seenIds.add(node.id);
    nodes.push(node);
  });

  // Dep-graph checks (unknown id refs, cycles). Only meaningful when every
  // node parsed successfully — otherwise the graph is incomplete.
  if (nodes.length === rawArr.length) {
    checkDependencyGraph(nodes, basePath, errors);
  }

  return errors.length === 0 || nodes.length > 0 ? nodes : undefined;
}

function validateNode(
  rawIn: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): DagNode | undefined {
  // Normalize `agent:` → `subagent:` so the discriminator + dispatcher only
  // ever see one field name (4a.2 / D16). `agent:` is the canonical
  // workflow-author-facing name going forward; `subagent:` is the legacy
  // alias preserved for back-compat with the 6 example workflows + any
  // user-authored YAML in flight.
  let raw = rawIn;
  if (raw.agent !== undefined || raw.subagent !== undefined) {
    if (raw.agent !== undefined && raw.subagent !== undefined) {
      errors.push({
        path,
        message: 'declare either `agent:` or `subagent:`, not both',
      });
      return undefined;
    }
    if (raw.agent !== undefined && raw.subagent === undefined) {
      raw = { ...rawIn, subagent: rawIn.agent };
      delete raw.agent;
    }
  }
  // 4a.6 / D23: `human-review:` is the canonical name for the existing
  // approval step kind. `approval:` is the back-compat alias preserved for
  // the seed workflows + any user YAML in flight. Same mutually-exclusive
  // rule as `agent:` / `subagent:`. Normalize to `approval:` so the
  // discriminator + dispatcher see one field name.
  if (raw['human-review'] !== undefined || raw.approval !== undefined) {
    if (raw['human-review'] !== undefined && raw.approval !== undefined) {
      errors.push({
        path,
        message: 'declare either `human-review:` or `approval:`, not both',
      });
      return undefined;
    }
    if (raw['human-review'] !== undefined && raw.approval === undefined) {
      raw = { ...raw, approval: raw['human-review'] };
      delete raw['human-review'];
    }
  }

  // id
  if (typeof raw.id !== 'string' || !raw.id) {
    errors.push({ path: `${path}.id`, message: 'must be a non-empty string' });
    return undefined;
  }
  const id = raw.id;

  // depends_on
  let dependsOn: string[] | undefined;
  if (raw.depends_on !== undefined) {
    if (!Array.isArray(raw.depends_on) || raw.depends_on.some((x) => typeof x !== 'string' || !x)) {
      errors.push({
        path: `${path}.depends_on`,
        message: 'must be an array of non-empty strings',
      });
    } else {
      dependsOn = raw.depends_on as string[];
    }
  }

  // when
  if (raw.when !== undefined && (typeof raw.when !== 'string' || !raw.when)) {
    errors.push({ path: `${path}.when`, message: 'must be a non-empty string if provided' });
  }

  // trigger_rule
  let triggerRule: TriggerRule | undefined;
  if (raw.trigger_rule !== undefined) {
    if (typeof raw.trigger_rule !== 'string' || !TRIGGER_RULES.has(raw.trigger_rule as TriggerRule)) {
      errors.push({
        path: `${path}.trigger_rule`,
        message: `must be one of ${[...TRIGGER_RULES].join(', ')}`,
      });
    } else {
      triggerRule = raw.trigger_rule as TriggerRule;
    }
  }

  // done_when
  let doneWhen: DoneWhen | undefined;
  if (raw.done_when !== undefined) {
    doneWhen = validateDoneWhen(raw.done_when, `${path}.done_when`, errors);
  }

  // timeout
  if (raw.timeout !== undefined) {
    if (typeof raw.timeout !== 'number' || !Number.isFinite(raw.timeout) || raw.timeout <= 0) {
      errors.push({
        path: `${path}.timeout`,
        message: 'must be a positive number (milliseconds) if provided',
      });
    }
  }

  // retry (4a.7 / D17)
  let retry: RetryPolicy | undefined;
  if (raw.retry !== undefined) {
    retry = validateRetry(raw.retry, `${path}.retry`, errors);
  }

  // Discriminator: exactly one type-body field must be present.
  const present = TYPE_BODY_FIELDS.filter((f) => raw[f] !== undefined);
  if (present.length === 0) {
    errors.push({
      path,
      message: `must declare exactly one of: ${TYPE_BODY_FIELDS.join(', ')}`,
    });
    return undefined;
  }
  if (present.length > 1) {
    errors.push({
      path,
      message: `must declare exactly one type-body field; found multiple: ${present.join(', ')}`,
    });
    return undefined;
  }

  // Build the node by kind. Compose base fields onto the variant object.
  const base = {
    id,
    ...(dependsOn ? { depends_on: dependsOn } : {}),
    ...(typeof raw.when === 'string' && raw.when ? { when: raw.when } : {}),
    ...(triggerRule ? { trigger_rule: triggerRule } : {}),
    ...(doneWhen ? { done_when: doneWhen } : {}),
    ...(typeof raw.timeout === 'number' && raw.timeout > 0 ? { timeout: raw.timeout } : {}),
    ...(retry ? { retry } : {}),
  };

  const kind = present[0]!;
  switch (kind) {
    case 'subagent':
      return validateSubagentBody(raw, base, path, errors);
    case 'bash':
      return validateBashBody(raw, base, path, errors);
    case 'http':
      return validateHttpBody(raw, base, path, errors);
    case 'script':
      return validateScriptBody(raw, base, path, errors);
    case 'approval':
      return validateApprovalBody(raw, base, path, errors);
    case 'cancel':
      return validateCancelBody(raw, base, path, errors);
    case 'workflow':
      return validateNestedWorkflowBody(raw, base, path, errors);
    case 'loop':
      return validateLoopBody(raw, base, path, errors);
    case 'attach-to-work-item':
      return validateAttachToWorkItemBody(raw, base, path, errors);
    case 'create-work-item':
      return validateCreateWorkItemBody(raw, base, path, errors);
    case 'update-work-item':
      return validateUpdateWorkItemBody(raw, base, path, errors);
    case 'write-to-worktree':
      return validateWriteToWorktreeBody(raw, base, path, errors);
    case 'orchestrator-review':
      return validateOrchestratorReviewBody(raw, base, path, errors);
  }
}

function validateSubagentBody(
  raw: Record<string, unknown>,
  base: BaseFields,
  path: string,
  errors: ValidationError[],
): SubagentNode | undefined {
  let ok = true;
  if (typeof raw.subagent !== 'string' || !raw.subagent) {
    errors.push({ path: `${path}.subagent`, message: 'must be a non-empty string' });
    ok = false;
  }
  if (typeof raw.prompt !== 'string' || !raw.prompt) {
    errors.push({ path: `${path}.prompt`, message: 'must be a non-empty string' });
    ok = false;
  }
  if (!ok) return undefined;
  return { ...base, kind: 'subagent', subagent: raw.subagent as string, prompt: raw.prompt as string };
}

function validateBashBody(
  raw: Record<string, unknown>,
  base: BaseFields,
  path: string,
  errors: ValidationError[],
): BashNode | undefined {
  if (typeof raw.bash !== 'string' || !raw.bash) {
    errors.push({ path: `${path}.bash`, message: 'must be a non-empty string' });
    return undefined;
  }
  return { ...base, kind: 'bash', bash: raw.bash };
}

function validateHttpBody(
  raw: Record<string, unknown>,
  base: BaseFields,
  path: string,
  errors: ValidationError[],
): HttpNode | undefined {
  if (!isObj(raw.http)) {
    errors.push({ path: `${path}.http`, message: 'must be an object' });
    return undefined;
  }
  const http = raw.http;
  let ok = true;

  let method: HttpNode['http']['method'] | undefined;
  if (typeof http.method !== 'string') {
    errors.push({ path: `${path}.http.method`, message: 'must be a string' });
    ok = false;
  } else if (!HTTP_METHODS.has(http.method as HttpNode['http']['method'])) {
    errors.push({
      path: `${path}.http.method`,
      message: `must be one of ${[...HTTP_METHODS].join(', ')}`,
    });
    ok = false;
  } else {
    method = http.method as HttpNode['http']['method'];
  }

  if (typeof http.url !== 'string' || !http.url) {
    errors.push({ path: `${path}.http.url`, message: 'must be a non-empty string' });
    ok = false;
  }

  let headers: Record<string, string> | undefined;
  if (http.headers !== undefined) {
    headers = validateStringRecord(http.headers, `${path}.http.headers`, errors);
    if (!headers && Array.isArray(http.headers)) ok = false;
  }

  if (http.body !== undefined && typeof http.body !== 'string') {
    errors.push({
      path: `${path}.http.body`,
      message: 'must be a string if provided (JSON encoding is the author\'s responsibility)',
    });
    ok = false;
  }

  if (http.timeout !== undefined) {
    if (typeof http.timeout !== 'number' || !Number.isFinite(http.timeout) || http.timeout <= 0) {
      errors.push({
        path: `${path}.http.timeout`,
        message: 'must be a positive number (milliseconds) if provided',
      });
      ok = false;
    }
  }

  if (!ok || !method) return undefined;
  return {
    ...base,
    kind: 'http',
    http: {
      method,
      url: http.url as string,
      ...(headers ? { headers } : {}),
      ...(typeof http.body === 'string' ? { body: http.body } : {}),
      ...(typeof http.timeout === 'number' && http.timeout > 0
        ? { timeout: http.timeout }
        : {}),
    },
  };
}

function validateScriptBody(
  raw: Record<string, unknown>,
  base: BaseFields,
  path: string,
  errors: ValidationError[],
): ScriptNode | undefined {
  let ok = true;
  if (typeof raw.script !== 'string' || !raw.script) {
    errors.push({ path: `${path}.script`, message: 'must be a non-empty string' });
    ok = false;
  }
  if (raw.runtime !== 'node' && raw.runtime !== 'python') {
    errors.push({ path: `${path}.runtime`, message: 'must be "node" or "python"' });
    ok = false;
  }
  if (!ok) return undefined;
  return {
    ...base,
    kind: 'script',
    script: raw.script as string,
    runtime: raw.runtime as 'node' | 'python',
  };
}

function validateApprovalBody(
  raw: Record<string, unknown>,
  base: BaseFields,
  path: string,
  errors: ValidationError[],
): ApprovalNode | undefined {
  if (!isObj(raw.approval)) {
    errors.push({ path: `${path}.approval`, message: 'must be an object' });
    return undefined;
  }
  const approval = raw.approval;
  let ok = true;
  if (typeof approval.message !== 'string' || !approval.message) {
    errors.push({
      path: `${path}.approval.message`,
      message: 'must be a non-empty string',
    });
    ok = false;
  }
  let on_reject: ApprovalNode['approval']['on_reject'] | undefined;
  if (approval.on_reject !== undefined) {
    if (!isObj(approval.on_reject)) {
      errors.push({
        path: `${path}.approval.on_reject`,
        message: 'must be an object if provided',
      });
      ok = false;
    } else if (
      typeof approval.on_reject.prompt !== 'string' ||
      !approval.on_reject.prompt
    ) {
      errors.push({
        path: `${path}.approval.on_reject.prompt`,
        message: 'must be a non-empty string',
      });
      ok = false;
    } else {
      on_reject = { prompt: approval.on_reject.prompt };
    }
  }
  if (!ok) return undefined;
  return {
    ...base,
    kind: 'approval',
    approval: {
      message: approval.message as string,
      ...(on_reject ? { on_reject } : {}),
    },
  };
}

function validateCancelBody(
  raw: Record<string, unknown>,
  base: BaseFields,
  path: string,
  errors: ValidationError[],
): CancelNode | undefined {
  if (typeof raw.cancel !== 'string' || !raw.cancel) {
    errors.push({ path: `${path}.cancel`, message: 'must be a non-empty string' });
    return undefined;
  }
  return { ...base, kind: 'cancel', cancel: raw.cancel };
}

function validateNestedWorkflowBody(
  raw: Record<string, unknown>,
  base: BaseFields,
  path: string,
  errors: ValidationError[],
): NestedWorkflowNode | undefined {
  if (typeof raw.workflow !== 'string' || !raw.workflow) {
    errors.push({ path: `${path}.workflow`, message: 'must be a non-empty string' });
    return undefined;
  }
  // D16: dynamic-id substitution is limited to subagent `agent:`. Nested
  // workflow `workflow:` references resolve a static workflow file at
  // dispatch time — runtime expansion would defeat the cycle/depth guards.
  if (raw.workflow.startsWith('$')) {
    errors.push({
      path: `${path}.workflow`,
      message: 'must be a static workflow id; `$inputs.*` / `$<stepId>.output.*` not allowed here (D16)',
    });
    return undefined;
  }
  const inputs = validateStringRecord(raw.inputs, `${path}.inputs`, errors);
  return {
    ...base,
    kind: 'workflow',
    workflow: raw.workflow,
    ...(inputs ? { inputs } : {}),
  };
}

function validateLoopBody(
  raw: Record<string, unknown>,
  base: BaseFields,
  path: string,
  errors: ValidationError[],
): LoopNode | undefined {
  if (!isObj(raw.loop)) {
    errors.push({ path: `${path}.loop`, message: 'must be an object' });
    return undefined;
  }
  const loop = raw.loop;
  let ok = true;

  if (typeof loop.until !== 'string' || !loop.until) {
    errors.push({ path: `${path}.loop.until`, message: 'must be a non-empty string' });
    ok = false;
  }
  if (
    typeof loop.max_iterations !== 'number' ||
    !Number.isInteger(loop.max_iterations) ||
    loop.max_iterations <= 0
  ) {
    errors.push({
      path: `${path}.loop.max_iterations`,
      message: 'must be a positive integer',
    });
    ok = false;
  }

  let body: DagNode[] | undefined;
  if (!Array.isArray(loop.body) || loop.body.length === 0) {
    errors.push({ path: `${path}.loop.body`, message: 'must be a non-empty array' });
    ok = false;
  } else {
    body = validateNodeArray(loop.body, `${path}.loop.body`, errors);
    if (!body || body.length === 0) ok = false;
  }

  if (!ok || !body) return undefined;
  return {
    ...base,
    kind: 'loop',
    loop: {
      body,
      until: loop.until as string,
      max_iterations: loop.max_iterations as number,
    },
  };
}

function validateAttachToWorkItemBody(
  raw: Record<string, unknown>,
  base: BaseFields,
  path: string,
  errors: ValidationError[],
): AttachToWorkItemNode | undefined {
  const body = raw['attach-to-work-item'];
  if (!isObj(body)) {
    errors.push({ path: `${path}.attach-to-work-item`, message: 'must be an object' });
    return undefined;
  }
  let ok = true;
  if (typeof body.workItemId !== 'string' || !body.workItemId) {
    errors.push({
      path: `${path}.attach-to-work-item.workItemId`,
      message: 'must be a non-empty string',
    });
    ok = false;
  }
  if (typeof body.name !== 'string' || !body.name) {
    errors.push({
      path: `${path}.attach-to-work-item.name`,
      message: 'must be a non-empty string',
    });
    ok = false;
  }
  if (typeof body.content !== 'string' || !body.content) {
    errors.push({
      path: `${path}.attach-to-work-item.content`,
      message: 'must be a non-empty string',
    });
    ok = false;
  }
  if (body.kind !== undefined && (typeof body.kind !== 'string' || !body.kind)) {
    errors.push({
      path: `${path}.attach-to-work-item.kind`,
      message: 'must be a non-empty string if provided',
    });
    ok = false;
  }
  if (body.contentType !== undefined && (typeof body.contentType !== 'string' || !body.contentType)) {
    errors.push({
      path: `${path}.attach-to-work-item.contentType`,
      message: 'must be a non-empty string if provided',
    });
    ok = false;
  }
  if (!ok) return undefined;
  return {
    ...base,
    kind: 'attach-to-work-item',
    'attach-to-work-item': {
      workItemId: body.workItemId as string,
      name: body.name as string,
      content: body.content as string,
      ...(typeof body.kind === 'string' ? { kind: body.kind } : {}),
      ...(typeof body.contentType === 'string' ? { contentType: body.contentType } : {}),
    },
  };
}

function validateCreateWorkItemBody(
  raw: Record<string, unknown>,
  base: BaseFields,
  path: string,
  errors: ValidationError[],
): CreateWorkItemNode | undefined {
  const body = raw['create-work-item'];
  if (!isObj(body)) {
    errors.push({ path: `${path}.create-work-item`, message: 'must be an object' });
    return undefined;
  }
  let ok = true;
  if (typeof body.title !== 'string' || !body.title) {
    errors.push({
      path: `${path}.create-work-item.title`,
      message: 'must be a non-empty string',
    });
    ok = false;
  }
  if (body.body !== undefined && typeof body.body !== 'string') {
    errors.push({
      path: `${path}.create-work-item.body`,
      message: 'must be a string if provided',
    });
    ok = false;
  }
  if (body.stage !== undefined && (typeof body.stage !== 'string' || !body.stage)) {
    errors.push({
      path: `${path}.create-work-item.stage`,
      message: 'must be a non-empty string if provided',
    });
    ok = false;
  }
  if (body.parentId !== undefined && (typeof body.parentId !== 'string' || !body.parentId)) {
    errors.push({
      path: `${path}.create-work-item.parentId`,
      message: 'must be a non-empty string if provided',
    });
    ok = false;
  }
  if (!ok) return undefined;
  return {
    ...base,
    kind: 'create-work-item',
    'create-work-item': {
      title: body.title as string,
      ...(typeof body.body === 'string' ? { body: body.body } : {}),
      ...(typeof body.stage === 'string' ? { stage: body.stage } : {}),
      ...(typeof body.parentId === 'string' ? { parentId: body.parentId } : {}),
    },
  };
}

function validateUpdateWorkItemBody(
  raw: Record<string, unknown>,
  base: BaseFields,
  path: string,
  errors: ValidationError[],
): UpdateWorkItemNode | undefined {
  const body = raw['update-work-item'];
  if (!isObj(body)) {
    errors.push({ path: `${path}.update-work-item`, message: 'must be an object' });
    return undefined;
  }
  let ok = true;
  if (typeof body.workItemId !== 'string' || !body.workItemId) {
    errors.push({
      path: `${path}.update-work-item.workItemId`,
      message: 'must be a non-empty string',
    });
    ok = false;
  }
  if (body.title !== undefined && typeof body.title !== 'string') {
    errors.push({
      path: `${path}.update-work-item.title`,
      message: 'must be a string if provided',
    });
    ok = false;
  }
  if (body.body !== undefined && typeof body.body !== 'string') {
    errors.push({
      path: `${path}.update-work-item.body`,
      message: 'must be a string if provided',
    });
    ok = false;
  }
  if (body.stage !== undefined && (typeof body.stage !== 'string' || !body.stage)) {
    errors.push({
      path: `${path}.update-work-item.stage`,
      message: 'must be a non-empty string if provided',
    });
    ok = false;
  }
  if (body.fields !== undefined && !isObj(body.fields)) {
    errors.push({
      path: `${path}.update-work-item.fields`,
      message: 'must be an object if provided',
    });
    ok = false;
  }
  if (!ok) return undefined;
  const hasAnyChange =
    body.title !== undefined ||
    body.body !== undefined ||
    body.stage !== undefined ||
    body.fields !== undefined;
  if (!hasAnyChange) {
    errors.push({
      path: `${path}.update-work-item`,
      message: 'must declare at least one of: title, body, stage, fields',
    });
    return undefined;
  }
  return {
    ...base,
    kind: 'update-work-item',
    'update-work-item': {
      workItemId: body.workItemId as string,
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.body === 'string' ? { body: body.body } : {}),
      ...(typeof body.stage === 'string' ? { stage: body.stage } : {}),
      ...(isObj(body.fields) ? { fields: body.fields as Record<string, unknown> } : {}),
    },
  };
}

function validateOrchestratorReviewBody(
  raw: Record<string, unknown>,
  base: BaseFields,
  path: string,
  errors: ValidationError[],
): OrchestratorReviewNode | undefined {
  const body = raw['orchestrator-review'];
  if (!isObj(body)) {
    errors.push({ path: `${path}.orchestrator-review`, message: 'must be an object' });
    return undefined;
  }
  let ok = true;
  if (typeof body.prompt !== 'string' || !body.prompt) {
    errors.push({
      path: `${path}.orchestrator-review.prompt`,
      message: 'must be a non-empty string',
    });
    ok = false;
  }
  if (body.artifact !== undefined && (typeof body.artifact !== 'string' || !body.artifact)) {
    errors.push({
      path: `${path}.orchestrator-review.artifact`,
      message: 'must be a non-empty string if provided',
    });
    ok = false;
  }
  let onRevise: OrchestratorReviewNode['orchestrator-review']['on_revise'] | undefined;
  if (body.on_revise !== undefined) {
    if (!isObj(body.on_revise)) {
      errors.push({
        path: `${path}.orchestrator-review.on_revise`,
        message: 'must be an object if provided',
      });
      ok = false;
    } else if (typeof body.on_revise.prompt !== 'string' || !body.on_revise.prompt) {
      errors.push({
        path: `${path}.orchestrator-review.on_revise.prompt`,
        message: 'must be a non-empty string',
      });
      ok = false;
    } else {
      onRevise = { prompt: body.on_revise.prompt };
    }
  }
  if (!ok) return undefined;
  return {
    ...base,
    kind: 'orchestrator-review',
    'orchestrator-review': {
      prompt: body.prompt as string,
      ...(typeof body.artifact === 'string' ? { artifact: body.artifact } : {}),
      ...(onRevise ? { on_revise: onRevise } : {}),
    },
  };
}

function validateWriteToWorktreeBody(
  raw: Record<string, unknown>,
  base: BaseFields,
  path: string,
  errors: ValidationError[],
): WriteToWorktreeNode | undefined {
  const body = raw['write-to-worktree'];
  if (!isObj(body)) {
    errors.push({ path: `${path}.write-to-worktree`, message: 'must be an object' });
    return undefined;
  }
  let ok = true;
  if (typeof body.path !== 'string' || !body.path) {
    errors.push({
      path: `${path}.write-to-worktree.path`,
      message: 'must be a non-empty string',
    });
    ok = false;
  }
  if (typeof body.content !== 'string') {
    errors.push({
      path: `${path}.write-to-worktree.content`,
      message: 'must be a string',
    });
    ok = false;
  }
  if (
    body.mode !== undefined &&
    body.mode !== 'overwrite' &&
    body.mode !== 'append'
  ) {
    errors.push({
      path: `${path}.write-to-worktree.mode`,
      message: 'must be "overwrite" or "append" if provided',
    });
    ok = false;
  }
  if (!ok) return undefined;
  return {
    ...base,
    kind: 'write-to-worktree',
    'write-to-worktree': {
      path: body.path as string,
      content: body.content as string,
      ...(body.mode === 'overwrite' || body.mode === 'append' ? { mode: body.mode } : {}),
    },
  };
}

const RETRY_CAUSES: ReadonlySet<RetryCause> = new Set(['failed', 'timeout']);

function validateRetry(
  raw: unknown,
  path: string,
  errors: ValidationError[],
): RetryPolicy | undefined {
  if (!isObj(raw)) {
    errors.push({ path, message: 'must be an object' });
    return undefined;
  }
  let ok = true;
  let maxAttempts: number | undefined;
  if (
    typeof raw.max_attempts !== 'number' ||
    !Number.isInteger(raw.max_attempts) ||
    raw.max_attempts < 1
  ) {
    errors.push({
      path: `${path}.max_attempts`,
      message: 'must be a positive integer (>= 1)',
    });
    ok = false;
  } else {
    maxAttempts = raw.max_attempts;
  }
  let on: RetryCause[] | undefined;
  if (raw.on !== undefined) {
    if (!Array.isArray(raw.on) || raw.on.length === 0) {
      errors.push({
        path: `${path}.on`,
        message: 'must be a non-empty array of: failed, timeout',
      });
      ok = false;
    } else {
      const bad = raw.on.filter(
        (c) => typeof c !== 'string' || !RETRY_CAUSES.has(c as RetryCause),
      );
      if (bad.length > 0) {
        errors.push({
          path: `${path}.on`,
          message: `invalid cause(s): ${JSON.stringify(bad)}; allowed: failed, timeout`,
        });
        ok = false;
      } else {
        on = raw.on as RetryCause[];
      }
    }
  }
  if (raw.delay_ms !== undefined) {
    if (typeof raw.delay_ms !== 'number' || !Number.isFinite(raw.delay_ms) || raw.delay_ms < 0) {
      errors.push({
        path: `${path}.delay_ms`,
        message: 'must be a non-negative number (milliseconds) if provided',
      });
      ok = false;
    }
  }
  if (!ok || maxAttempts === undefined) return undefined;
  return {
    max_attempts: maxAttempts,
    ...(on ? { on } : {}),
    ...(typeof raw.delay_ms === 'number' && raw.delay_ms >= 0 ? { delay_ms: raw.delay_ms } : {}),
  };
}

function validateDoneWhen(
  raw: unknown,
  path: string,
  errors: ValidationError[],
): DoneWhen | undefined {
  if (!isObj(raw)) {
    errors.push({ path, message: 'must be an object' });
    return undefined;
  }
  const out: DoneWhen = {};
  const files = raw['files-non-empty'];
  const fields = raw['output-fields-non-empty'];

  if (files === undefined && fields === undefined) {
    errors.push({
      path,
      message: 'must declare at least one of files-non-empty or output-fields-non-empty',
    });
    return undefined;
  }
  if (files !== undefined) {
    if (!Array.isArray(files) || files.length === 0 || files.some((x) => typeof x !== 'string' || !x)) {
      errors.push({
        path: `${path}.files-non-empty`,
        message: 'must be a non-empty array of strings',
      });
    } else {
      out['files-non-empty'] = files as string[];
    }
  }
  if (fields !== undefined) {
    if (!Array.isArray(fields) || fields.length === 0 || fields.some((x) => typeof x !== 'string' || !x)) {
      errors.push({
        path: `${path}.output-fields-non-empty`,
        message: 'must be a non-empty array of strings',
      });
    } else {
      out['output-fields-non-empty'] = fields as string[];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function validateStringRecord(
  raw: unknown,
  path: string,
  errors: ValidationError[],
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) {
    errors.push({ path, message: 'must be an object of name → string mappings' });
    return undefined;
  }
  const out: Record<string, string> = {};
  let ok = true;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string' || !v) {
      errors.push({ path: `${path}.${k}`, message: 'must be a non-empty string' });
      ok = false;
      continue;
    }
    out[k] = v;
  }
  return ok ? out : undefined;
}

function checkDependencyGraph(
  nodes: DagNode[],
  basePath: string,
  errors: ValidationError[],
): void {
  const ids = new Set(nodes.map((n) => n.id));

  // Unknown id refs
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!ids.has(dep)) {
        errors.push({
          path: `${basePath}[?].depends_on`,
          message: `node "${node.id}" depends on unknown id "${dep}"`,
        });
      }
    }
  }

  // Cycle detection via three-color DFS.
  const color = new Map<string, 'white' | 'gray' | 'black'>();
  for (const n of nodes) color.set(n.id, 'white');
  const adjacency = new Map<string, string[]>(
    nodes.map((n) => [n.id, (n.depends_on ?? []).filter((d) => ids.has(d))]),
  );

  const cycles: string[][] = [];
  function dfs(id: string, stack: string[]): void {
    color.set(id, 'gray');
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const c = color.get(next);
      if (c === 'gray') {
        const startIdx = stack.indexOf(next);
        cycles.push([...stack.slice(startIdx), next]);
      } else if (c === 'white') {
        dfs(next, stack);
      }
    }
    stack.pop();
    color.set(id, 'black');
  }
  for (const n of nodes) {
    if (color.get(n.id) === 'white') dfs(n.id, []);
  }

  // Dedupe cycles (DFS can hit the same cycle from multiple starts).
  const seen = new Set<string>();
  for (const c of cycles) {
    const norm = c.slice(0, -1).join(',');
    if (seen.has(norm)) continue;
    seen.add(norm);
    errors.push({
      path: basePath,
      message: `dependency cycle: ${c.join(' → ')}`,
    });
  }
}

type BaseFields = {
  id: string;
  depends_on?: string[];
  when?: string;
  trigger_rule?: TriggerRule;
  done_when?: DoneWhen;
  timeout?: number;
};

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function readPartialStageId(raw: unknown): string | undefined {
  if (!isObj(raw)) return undefined;
  const triggers = raw.triggers;
  if (!isObj(triggers)) return undefined;
  const onEnter = triggers.on_enter;
  if (!isObj(onEnter)) return undefined;
  const sid = onEnter.stage_id;
  return typeof sid === 'string' && sid ? sid : undefined;
}
