// Compiled separately because the prebuilt Sentry.xcframework from GitHub releases
// is missing this file (the .o is not in the static archive — a sentry-cocoa build bug).
// Uses @import Sentry instead of internal headers since we're building outside the framework.
#import <Sentry/SentrySessionReplayHybridSDK.h>
#import <Sentry/SentryDefines.h>

#if SENTRY_TARGET_REPLAY_SUPPORTED

@import Sentry;

@implementation SentrySessionReplayHybridSDK

+ (id<SentryRRWebEvent>)createBreadcrumbwithTimestamp:(NSDate *)timestamp
                                             category:(NSString *)category
                                              message:(nullable NSString *)message
                                                level:(SentryLevel)level
                                                 data:(nullable NSDictionary<NSString *, id> *)data
{
    return [[SentryRRWebBreadcrumbEvent alloc] initWithTimestamp:timestamp
                                                        category:category
                                                         message:message
                                                           level:level
                                                            data:data];
}

+ (id<SentryRRWebEvent>)createNetworkBreadcrumbWithTimestamp:(NSDate *)timestamp
                                                endTimestamp:(NSDate *)endTimestamp
                                                   operation:(NSString *)operation
                                                 description:(NSString *)description
                                                        data:(NSDictionary<NSString *, id> *)data
{
    return [[SentryRRWebSpanEvent alloc] initWithTimestamp:timestamp
                                              endTimestamp:endTimestamp
                                                 operation:operation
                                               description:description
                                                      data:data];
}

+ (id<SentryReplayBreadcrumbConverter>)createDefaultBreadcrumbConverter
{
    return [[SentrySRDefaultBreadcrumbConverter alloc] init];
}

@end

#endif
