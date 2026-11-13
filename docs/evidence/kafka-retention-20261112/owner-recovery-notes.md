# Approved exact-owner recovery preparation

User approved controlled recovery before release: stop web briefly, verify all publisher executors/ClickHouse requests terminated, recover only owner76f6989e while preserving intent/reservation, replay matching sink, restore services.

Original owner76f6989e-4dbc-41ae-b073-3588ddb038c4 backend3839851 absent. Live offset8450409 hashes to exact retained intent d83d1881e0d75557b973ae33c529654fe2f753bd00d9ddda29bea1d29a1e5a18. Reservation16:33:51.483685. Query efba1812-37b4-4b11-b719-438796aa0388 QueryFinish16:36:28 wrote100rows. Row quiescent=false/query_terminal=false. No mutation yet.

At22:22:04.605246635 dockerd explicitly logged legacy container53e937b9e32d failed to exit within30m of SIGTERM, using force. Task-delete22:22:04.647164117.
At22:22:12.450239869 dockerd explicitly logged history3c8cb4bdd5c9 failed to exit within30m of SIGTERM, using force. Task-delete22:22:12.673483291.
Both inspected after are absent; serviceallthree sinks0/0. No manual kill. Existing grace unchanged.

Services before saved owner-recovery-services-before.jsonl (all exact oldsha c1df0ea6, web2, backgrounds0 from cancelledrelease). Two independent Node processes running/paused=false:625f2ad480a4 angry_dhawan and c0fed2c1704e fullactivityresync. Review required actual termination, not pause; both stopped before SQL. Web stopped2->0 and actualcontainers absent. Freshproof: unfinished_erasure0, oldbackend0, CHotherprocesses0/mutations0/distribution0/asyncinserts0. ConditionalSQL changedexact1row (quiescent/query_terminal true, backendNULL), retainingoriginalowner/intent/ingested_at/queryid.

Only unchanged live sink restored0->1. Replacement ownerdf2d8a52-4213-4f3f-9706-46d4f0b400c8 admittedexactpendingintent with original16:33:51.483685reservation. It retirednormally and nextownerf300f6be-ded9-489d-9cbd-c9724dfb7d90 receivednewintent ed4ddb77... andnewreservation22:37:48.924706. Scaledlive0 normally, awaitedactualcontainer53e7757e5d07exit. Finalrowquiescent=true/query_terminal=true/intentNULL. NativeCHprocesses/mutations/distribution/asyncinsertsall0. NativeKafkagroupcommit8454055 >8450409, noactivegroupmembers. Nooffsetreset/ack/directintentclear.

At22:42:25UTC restoredweb2 and dockerstartnamedfullresyncexactoriginalimage0cb56839. Web2/2 public/healthHTTP200 verified. Allotherbackgroundsremainpre-recovery0 pendingcanonicalrelease. Fullresyncwasstoppedexit137 andnowrunningtrue. DisposableotherNode625f2ad480a4wasAutoRemove andstdin-onlynode --input-type=module; Dockerremovedit. Snapshotoriginalimage/args/no mounts preservedprivately, butoriginalstdinprogramisnotretainedandcannotberecreatedfromDockerconfiguration. Purposeunconfirmed; do not invent/replayunknownoperatorcommand. Restoringmanagedservices/namedresync doesnotrestorethatone-off process.

Automatic release disabled_manually must restore after corrected main qualifies. PR3290 mergedc7909fdafb0ad868407c9de493e3bd4e72f83b51 at22:38:35 afterPRCI43318558723success (103successfulchecks). MainCI43321788746pendingbehind728e7f5CI43319721248; do notcancelothers. No branchswitch.
