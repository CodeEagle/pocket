#import "PocketArchivePlugin.h"
#import <Foundation/Foundation.h>
#include "pocket_archive_native.h"

static BOOL PocketArchiveHasNul(NSString *value) {
  return [value rangeOfCharacterFromSet:
      [NSCharacterSet characterSetWithRange:NSMakeRange(0, 1)]].location != NSNotFound;
}

@interface PocketArchivePlugin ()
@property(nonatomic, strong) dispatch_queue_t extractionQueue;
@end

@implementation PocketArchivePlugin
+ (void)registerWithRegistrar:(NSObject<FlutterPluginRegistrar> *)registrar {
  FlutterMethodChannel *channel = [FlutterMethodChannel
      methodChannelWithName:@"dev.pocketjs/pocket_archive"
      binaryMessenger:registrar.messenger];
  PocketArchivePlugin *instance = [[PocketArchivePlugin alloc] init];
  instance.extractionQueue = dispatch_queue_create(
      "dev.pocketjs.pocket_archive.extract", DISPATCH_QUEUE_SERIAL);
  [registrar addMethodCallDelegate:instance channel:channel];
}

- (void)handleMethodCall:(FlutterMethodCall *)call result:(FlutterResult)result {
  if (![call.method isEqualToString:@"extract"]) {
    result(FlutterMethodNotImplemented);
    return;
  }
  NSDictionary *arguments = [call.arguments isKindOfClass:NSDictionary.class] ? call.arguments : nil;
  NSString *archive = arguments[@"archivePath"];
  NSString *destination = arguments[@"destinationPath"];
  id password = arguments[@"password"];
  if (password == NSNull.null) password = nil;
  NSNumber *quota = arguments[@"maxOutputBytes"];
  if (![archive isKindOfClass:NSString.class] || !archive.isAbsolutePath ||
      ![destination isKindOfClass:NSString.class] || !destination.isAbsolutePath ||
      [destination.stringByStandardizingPath isEqualToString:@"/"] ||
      ![quota isKindOfClass:NSNumber.class] || quota.longLongValue <= 0 ||
      (password != nil && ![password isKindOfClass:NSString.class]) ||
      PocketArchiveHasNul(archive) || PocketArchiveHasNul(destination) ||
      (password != nil && PocketArchiveHasNul(password))) {
    result([FlutterError errorWithCode:@"invalid_arguments"
        message:@"Expected absolute paths, positive output quota and optional NUL-free password."
        details:nil]);
    return;
  }
  dispatch_async(self.extractionQueue, ^{
    @autoreleasepool {
      char error[256] = {0};
      int32_t status = pocket_archive_extract(archive.fileSystemRepresentation,
          destination.fileSystemRepresentation, [password UTF8String],
          quota.unsignedLongLongValue, error, sizeof(error));
      NSString *message = status == 0 ? nil :
          ([NSString stringWithUTF8String:error] ?: @"Native archive extraction failed.");
      dispatch_async(dispatch_get_main_queue(), ^{
        if (status == 0) {
          result(nil);
        } else {
          result([FlutterError errorWithCode:@"archive_extract"
              message:message details:@{@"nativeCode": @(status)}]);
        }
      });
    }
  });
}
@end
