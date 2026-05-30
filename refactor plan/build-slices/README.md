# Build Slice Plans

This folder holds implementation slice plans created after the roadmap, foundation specs, and Phase 0 test characterization plan are drafted.

Do not implement from this folder unless the user explicitly asks to build.

Every build-slice plan should include:

- roadmap phase;
- problem statement;
- exact scope and non-goals;
- current-state evidence;
- contracts or compatibility contracts;
- files likely affected;
- migration steps;
- rollback plan;
- tests and manual verification;
- stop conditions;
- tracker update.

Every slice should follow the cartridge shape:

```text
contract
  -> app service / repo boundary
  -> route adapter
  -> live event or mailbox fact
  -> web client/hook
  -> MCP adapter when relevant
  -> tests
```

