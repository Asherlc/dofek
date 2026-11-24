import SwiftUI
import WidgetKit

@main
struct DofekSleepWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(
            kind: SleepWidgetSnapshot.kind,
            provider: SleepWidgetTimelineProvider()
        ) { entry in
            SleepWidgetView(entry: entry)
        }
        .configurationDisplayName("Sleep")
        .description("Last night's sleep from Dofek.")
        .supportedFamilies([.systemSmall, .accessoryRectangular])
    }
}
