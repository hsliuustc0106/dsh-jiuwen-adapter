## What and why

<!-- One or two sentences. Link the issue / scenario. -->

## Tests

- [ ] `npm run lint` and `npm test` pass locally (Node ≥ 22)
- [ ] `npm run test:coverage` passes (coverage floors + test-count baseline in `test/baseline.json`)
- [ ] New behaviour or fix has a test; a new scenario is listed in `test/scenario-catalog.test.js`
- [ ] Added tests: baseline bumped with `npm run test:baseline:update` and `test/baseline.json` committed
- [ ] Removed or merged tests: baseline lowered with `-- --allow-drop`, reason given below
- [ ] Touches Gateway / host-sync / MCP / busy paths: live guard run on the box (`bash scripts/guard-live.sh`), summary: <!-- /workspace/guard-logs/<date>.md, PASS/FAIL -->
- [ ] No secrets in code, fixtures, logs or this PR

## Notes for reviewers

<!-- Risk, follow-ups, anything the tests do not cover. -->
