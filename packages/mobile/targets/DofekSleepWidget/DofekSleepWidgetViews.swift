import SwiftUI
import WidgetKit

struct SleepWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: SleepWidgetEntry

    /// Fixed dark Home background from the approved artboards; light ink stays readable in light mode.
    private static let homeBackground = Color(red: 20 / 255, green: 39 / 255, blue: 31 / 255)
    private static let homeInk = Color(red: 241 / 255, green: 247 / 255, blue: 242 / 255)
    private static let homeMuted = Color(red: 194 / 255, green: 212 / 255, blue: 199 / 255)
    private static let headingTint = Color(red: 169 / 255, green: 223 / 255, blue: 189 / 255)

    var body: some View {
        Group {
            switch family {
            case .accessoryRectangular:
                accessoryContent
            default:
                homeContent
            }
        }
        .widgetURL(entry.snapshot.destinationURL)
    }

    private var homeContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Sleep", systemImage: "moon.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Self.headingTint)
            Spacer(minLength: 0)
            homeBody
        }
        .foregroundStyle(Self.homeInk)
        .padding()
        .modifier(SleepWidgetBackgroundModifier(accessory: false, homeBackground: Self.homeBackground))
    }

    private var accessoryContent: some View {
        HStack(alignment: .center, spacing: 6) {
            Image(systemName: "moon.fill")
                .font(.caption)
            accessoryBody
            Spacer(minLength: 0)
        }
        .modifier(SleepWidgetBackgroundModifier(accessory: true, homeBackground: Self.homeBackground))
    }

    @ViewBuilder
    private var homeBody: some View {
        switch entry.snapshot {
        case let .sleep(date, durationMinutes, _):
            VStack(alignment: .leading, spacing: 2) {
                Text(SleepWidgetFormatting.duration(durationMinutes))
                    .font(.title2.weight(.semibold))
                    .privacySensitive()
                Text(SleepWidgetFormatting.displayDate(date))
                    .font(.caption)
                    .foregroundStyle(Self.homeMuted)
                    .privacySensitive()
            }
        case .empty:
            Text("No recent sleep recorded")
                .font(.caption)
                .foregroundStyle(Self.homeMuted)
        case .signedOut:
            Text("Sign in to Dofek")
                .font(.caption)
                .foregroundStyle(Self.homeMuted)
        case .needsUpdate:
            Text("Open Overview to update")
                .font(.caption)
                .foregroundStyle(Self.homeMuted)
        case .locked:
            SleepWidgetLockedPlaceholder(accessory: false, ink: Self.homeMuted)
        }
    }

    @ViewBuilder
    private var accessoryBody: some View {
        switch entry.snapshot {
        case let .sleep(date, durationMinutes, _):
            // Lock Screen artboard: date above duration.
            VStack(alignment: .leading, spacing: 2) {
                Text("Sleep · \(SleepWidgetFormatting.displayDate(date))")
                    .font(.caption)
                    .privacySensitive()
                Text(SleepWidgetFormatting.duration(durationMinutes))
                    .font(.headline)
                    .privacySensitive()
            }
        case .empty:
            Text("No recent sleep recorded")
                .font(.caption)
        case .signedOut:
            Text("Sign in to Dofek")
                .font(.caption)
        case .needsUpdate:
            Text("Open Overview to update")
                .font(.caption)
        case .locked:
            SleepWidgetLockedPlaceholder(accessory: true, ink: Color.primary.opacity(0.35))
        }
    }
}

/// Generic redacted Locked bars matching the approved privacy artboard (no personal values).
private struct SleepWidgetLockedPlaceholder: View {
    let accessory: Bool
    let ink: Color

    var body: some View {
        VStack(alignment: .leading, spacing: accessory ? 4 : 6) {
            Capsule()
                .fill(ink.opacity(0.55))
                .frame(width: accessory ? 72 : 88, height: accessory ? 8 : 12)
            Capsule()
                .fill(ink.opacity(0.35))
                .frame(width: accessory ? 108 : 124, height: accessory ? 8 : 10)
        }
        .accessibilityLabel("Content hidden while locked")
    }
}

private struct SleepWidgetBackgroundModifier: ViewModifier {
    let accessory: Bool
    let homeBackground: Color

    func body(content: Content) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            content.containerBackground(for: .widget) {
                if accessory {
                    AccessoryWidgetBackground()
                } else {
                    homeBackground
                }
            }
        } else if accessory {
            content
        } else {
            content.background(homeBackground)
        }
    }
}

enum SleepWidgetFormatting {
    static func duration(_ minutes: Int) -> String {
        let hours = minutes / 60
        let remainder = minutes % 60
        if hours > 0, remainder > 0 {
            return "\(hours) hr \(remainder) min"
        }
        if hours > 0 {
            return "\(hours) hr"
        }
        return "\(remainder) min"
    }

    static func displayDate(_ isoDate: String) -> String {
        guard SleepWidgetSnapshot.isValidCalendarDate(isoDate) else { return isoDate }
        let parts = isoDate.split(separator: "-")
        guard parts.count == 3,
              let month = Int(parts[1]),
              let day = Int(parts[2]),
              let symbols = DateFormatter().shortMonthSymbols,
              symbols.count >= month
        else {
            return isoDate
        }
        return "\(symbols[month - 1]) \(day)"
    }
}
