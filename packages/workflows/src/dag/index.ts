// Section 19.4 — pure DAG executor core (topology + when: + ref substitution).
// I/O-free; the server orchestration layer (apps/server) provides the
// RefResolver that reads child work items.
export { buildTopologicalLayers, computeUpstreams, forwardEdges, findForwardCycle } from './topo.ts';
export { evaluateCondition, checkTriggerRule } from './when.ts';
export { substituteRefs, shellQuote, type RefResolver } from './refs.ts';
