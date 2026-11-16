#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#import <libproc.h>
#import <unistd.h>

static NSString * const ServiceName = @"com.sifang.screentimeoutscheduler.daemon";

@protocol TimeoutService
// 服务只提供范围受限的熄屏分钟数设置，不接受命令路径或参数数组。
- (void)applyTimeout:(NSInteger)minutes withReply:(void (^)(BOOL, NSString *))reply;
@end

static NSString *SigningTeam(void) {
    SecCodeRef selfCode = NULL;
    CFDictionaryRef signingInfo = NULL;
    NSString *team = nil;
    if (SecCodeCopySelf(kSecCSDefaultFlags, &selfCode) == errSecSuccess &&
        SecCodeCopySigningInformation(selfCode, kSecCSSigningInformation, &signingInfo) == errSecSuccess) {
        team = [(__bridge NSDictionary *)signingInfo objectForKey:(__bridge NSString *)kSecCodeInfoTeamIdentifier];
    }
    if (signingInfo) CFRelease(signingInfo);
    if (selfCode) CFRelease(selfCode);
    return team;
}

@interface TimeoutDaemon : NSObject <NSXPCListenerDelegate, TimeoutService>
@end

@implementation TimeoutDaemon
- (BOOL)listener:(NSXPCListener *)listener shouldAcceptNewConnection:(NSXPCConnection *)connection {
    (void)listener;
    NSString *team = SigningTeam();
    // 锁屏时控制台用户可能切换为 loginwindow，因此按开发者签名鉴别客户端。
    if (!team.length || connection.effectiveUserIdentifier == 0) return NO;
    NSString *requirement = [NSString stringWithFormat:
        @"anchor apple generic and certificate leaf[subject.OU] = \"%@\"", team];
    [connection setCodeSigningRequirement:requirement];
    connection.exportedInterface = [NSXPCInterface interfaceWithProtocol:@protocol(TimeoutService)];
    connection.exportedObject = self;
    [connection resume];
    return YES;
}

- (void)applyTimeout:(NSInteger)minutes withReply:(void (^)(BOOL, NSString *))reply {
    if (minutes < 0 || minutes > 999) { reply(NO, @"熄屏时间超出允许范围"); return; }
    // 固定绝对路径并使用参数数组，避免执行来自 IPC 的 shell 文本。
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/pmset"];
    task.arguments = @[@"-a", @"displaysleep", [NSString stringWithFormat:@"%ld", (long)minutes]];
    NSPipe *errors = [NSPipe pipe];
    task.standardError = errors;
    NSError *launchError = nil;
    if (![task launchAndReturnError:&launchError]) {
        reply(NO, launchError.localizedDescription ?: @"无法启动 pmset");
        return;
    }
    [task waitUntilExit];
    NSData *data = [[errors fileHandleForReading] readDataToEndOfFile];
    NSString *detail = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    reply(task.terminationStatus == 0, detail ?: @"");
}
@end

static void PrintJSON(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
    if (data) {
        fwrite(data.bytes, 1, data.length, stdout);
        fputc('\n', stdout);
    }
}

static NSDictionary *ReadAssertions(void) {
    CFDictionaryRef raw = NULL;
    IOReturn result = IOPMCopyAssertionsByProcess(&raw);
    if (result != kIOReturnSuccess || !raw) return @{ @"ok": @NO, @"msg": @"无法读取电源断言" };
    NSMutableArray *entries = [NSMutableArray array];
    NSDictionary *byProcess = (__bridge NSDictionary *)raw;
    for (NSNumber *pidValue in byProcess) {
        pid_t pid = pidValue.intValue;
        char processName[PROC_PIDPATHINFO_MAXSIZE] = {0};
        proc_name(pid, processName, sizeof(processName));
        NSString *name = processName[0] ? [NSString stringWithUTF8String:processName] : [NSString stringWithFormat:@"PID %d", pid];
        for (NSDictionary *assertion in byProcess[pidValue]) {
            NSString *type = assertion[(__bridge NSString *)kIOPMAssertionTypeKey];
            NSNumber *level = assertion[(__bridge NSString *)kIOPMAssertionLevelKey];
            // 只列出会阻止显示器空闲熄屏的有效断言。
            if (![type isKindOfClass:NSString.class] || ![type containsString:@"DisplaySleep"] || level.intValue == 0) continue;
            NSString *reason = assertion[(__bridge NSString *)kIOPMAssertionHumanReadableReasonKey] ?: assertion[(__bridge NSString *)kIOPMAssertionNameKey] ?: @"";
            [entries addObject:@{
                @"section": @"显示器熄屏", @"type": @"PROCESS", @"target": name,
                @"name": name, @"reason": reason, @"pids": @[pidValue]
            }];
        }
    }
    CFRelease(raw);
    return @{ @"ok": @YES, @"entries": entries };
}

static NSDictionary *ApplyViaDaemon(NSInteger minutes) {
    NSXPCConnection *connection = [[NSXPCConnection alloc] initWithMachServiceName:ServiceName options:NSXPCConnectionPrivileged];
    connection.remoteObjectInterface = [NSXPCInterface interfaceWithProtocol:@protocol(TimeoutService)];
    [connection resume];
    dispatch_semaphore_t finished = dispatch_semaphore_create(0);
    __block BOOL success = NO;
    __block NSString *message = @"后台服务无响应；请检查系统设置中的登录项授权";
    id<TimeoutService> proxy = [connection remoteObjectProxyWithErrorHandler:^(NSError *error) {
        message = error.localizedDescription ?: message;
        dispatch_semaphore_signal(finished);
    }];
    [proxy applyTimeout:minutes withReply:^(BOOL ok, NSString *detail) {
        success = ok;
        message = detail ?: @"";
        dispatch_semaphore_signal(finished);
    }];
    long waited = dispatch_semaphore_wait(finished, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
    [connection invalidate];
    return @{ @"ok": @(waited == 0 && success), @"msg": waited == 0 ? message : @"后台服务响应超时" };
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        // launchd 以 root 身份且不带参数启动同一工具作为后台服务。
        if (argc == 1 && geteuid() == 0) {
            TimeoutDaemon *daemon = [[TimeoutDaemon alloc] init];
            NSXPCListener *listener = [[NSXPCListener alloc] initWithMachServiceName:ServiceName];
            listener.delegate = daemon;
            [listener resume];
            [[NSRunLoop currentRunLoop] run];
            return 0;
        }
        if (argc == 2 && strcmp(argv[1], "assertions") == 0) {
            PrintJSON(ReadAssertions());
            return 0;
        }
        if (argc == 3 && strcmp(argv[1], "apply") == 0) {
            NSString *input = [NSString stringWithUTF8String:argv[2]];
            NSScanner *scanner = [NSScanner scannerWithString:input];
            NSInteger value = -1;
            if (![scanner scanInteger:&value] || !scanner.isAtEnd || value < 0 || value > 999) {
                PrintJSON(@{ @"ok": @NO, @"msg": @"熄屏时间超出允许范围" });
                return 0;
            }
            PrintJSON(ApplyViaDaemon(value));
            return 0;
        }
        PrintJSON(@{ @"ok": @NO, @"msg": @"不支持的辅助工具命令" });
        return 1;
    }
}
