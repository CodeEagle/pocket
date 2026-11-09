#import <TargetConditionals.h>
#if TARGET_OS_OSX
#import <FlutterMacOS/FlutterMacOS.h>
#else
#import <Flutter/Flutter.h>
#endif

__attribute__((visibility("default")))
@interface PocketArchivePlugin : NSObject<FlutterPlugin>
@end
