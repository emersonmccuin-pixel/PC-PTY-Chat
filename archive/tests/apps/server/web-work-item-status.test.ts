import assert from 'node:assert/strict';
import { test } from 'node:test';

type WorkItemStatus =
  | 'pending'
  | 'in-progress'
  | 'awaiting-verification'
  | 'blocked'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'archived';

type StatusModule = {
  WORK_ITEM_STATUS_DOT_CLASS: Record<WorkItemStatus, string>;
  WORK_ITEM_STATUS_FILTER_OPTIONS: { value: WorkItemStatus; label: string }[];
  WORK_ITEM_STATUS_GLYPH: Record<WorkItemStatus, { glyph: string; className: string }>;
  WORK_ITEM_STATUS_GROUP_ORDER: WorkItemStatus[];
  WORK_ITEM_STATUS_LABEL: Record<WorkItemStatus, string>;
  WORK_ITEM_STATUS_ORDER: WorkItemStatus[];
  labelWorkItemStatus: (status: WorkItemStatus) => string;
};

async function loadStatusModule(): Promise<StatusModule> {
  const moduleUrl = new URL('../../web/src/features/work-items/status.ts', import.meta.url).href;
  return (await import(moduleUrl)) as StatusModule;
}

const DOMAIN_STATUSES: WorkItemStatus[] = [
  'pending',
  'in-progress',
  'awaiting-verification',
  'blocked',
  'complete',
  'failed',
  'cancelled',
  'archived',
];

test('work item status helper covers every server status', async () => {
  const status = await loadStatusModule();

  assert.deepEqual(status.WORK_ITEM_STATUS_ORDER, DOMAIN_STATUSES);
  assert.deepEqual(
    status.WORK_ITEM_STATUS_FILTER_OPTIONS.map((option) => option.value),
    DOMAIN_STATUSES,
  );
  assert.deepEqual(new Set(status.WORK_ITEM_STATUS_GROUP_ORDER), new Set(DOMAIN_STATUSES));

  for (const value of DOMAIN_STATUSES) {
    assert.equal(typeof status.WORK_ITEM_STATUS_LABEL[value], 'string', value);
    assert.ok(status.labelWorkItemStatus(value).length > 0, value);
    assert.ok(status.WORK_ITEM_STATUS_DOT_CLASS[value].length > 0, value);
    assert.ok(status.WORK_ITEM_STATUS_GLYPH[value].glyph.length > 0, value);
    assert.ok(status.WORK_ITEM_STATUS_GLYPH[value].className.length > 0, value);
  }
});
