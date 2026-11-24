import WidgetKit

struct SleepWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: SleepWidgetSnapshot
}

struct SleepWidgetTimelineProvider: TimelineProvider {
    /// Gallery / Locked privacy placeholder: generic redaction, no personal copy.
    func placeholder(in _: Context) -> SleepWidgetEntry {
        SleepWidgetEntry(date: Date(), snapshot: .locked)
    }

    func getSnapshot(in context: Context, completion: @escaping (SleepWidgetEntry) -> Void) {
        if context.isPreview {
            completion(
                SleepWidgetEntry(
                    date: Date(),
                    snapshot: .sleep(date: "2026-11-24", durationMinutes: 444, expiresAt: .max)
                )
            )
            return
        }
        completion(SleepWidgetEntry(date: Date(), snapshot: SleepWidgetSnapshotStore.load()))
    }

    func getTimeline(in _: Context, completion: @escaping (Timeline<SleepWidgetEntry>) -> Void) {
        let now = Date()
        let nowMilliseconds = Int64(now.timeIntervalSince1970 * 1000)
        let snapshot = SleepWidgetSnapshotStore.load(nowMilliseconds: nowMilliseconds)
        var entries = [SleepWidgetEntry(date: now, snapshot: snapshot)]
        if let expiration = snapshot.expirationDate, expiration > now {
            entries.append(SleepWidgetEntry(date: expiration, snapshot: .needsUpdate))
        }
        // New data arrives via explicit WidgetCenter reload after host writes.
        completion(Timeline(entries: entries, policy: .never))
    }
}
