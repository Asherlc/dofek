# CI repair ledger — PR3181 mutation coverage

Base ccab9bef9c65f7379bfeb2374b22f438b0479a85. Seven failing Stryker shards0/1/2/4/5/6/15 from run41230872239; no mutation config changes. Existing unit/mobile/integration tests pass. Exact logs/artifacts downloaded to /tmp/pr3181-stryker-* and /tmp/pr3181-mutations.

Independent scopes per dispatching-parallel-agents: Crimpd parser; board clients; other parsers/archive; root handles shard15 UI upload behavior and Aurora wrapper. No shared-file edits/commits by agents. Root reviews and pushes after verification, then monitors complete hosted CI.

Review checkpoint: independent review found no correctness/isolation blockers. Known static header and callback/grade-selection survivors received follow-up behavioral tests; targeted parser/archive mutations pass100%. Full lint, all4types and23776unit/mobile tests pass, plus139finalfocused tests. Original exact mutation scopes pass94.37–100%. Final Kilter schema verification pending, then commit/push and full hostedCI.

Local reproduction: use default .stryker-tmp and serialize runs. Custom nested tempDirName excludes only itself and may copy other sandbox trees; absolute /tmp sandboxing broke related-test discovery here. No tracked configuration changed.

Final verification checkpoint: two Kilter schema gaps killed2/2(100%). Final40Kiltertests and root typecheck pass; review found no important blockers. No production/config changes. Ready for commit/push and full hosted CI monitoring.
