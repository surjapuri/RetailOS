import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:hive_flutter/hive_flutter.dart';
import 'package:retailos/core/router/app_router.dart';
import 'package:retailos/core/theme/app_theme.dart';
import 'package:retailos/shared/services/offline_sync_service.dart';
import 'package:retailos/shared/services/notification_service.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();
  await Hive.initFlutter();
  await _setupSystemUI();
  await NotificationService.init();
  runApp(const ProviderScope(child: RetailOSApp()));
  // Start background sync in isolate
  OfflineSyncService.startBackgroundSync();
}

Future<void> _setupSystemUI() async {
  SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.landscapeLeft,   // POS tablet landscape
    DeviceOrientation.landscapeRight,
  ]);
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.dark,
  ));
}

class RetailOSApp extends ConsumerWidget {
  const RetailOSApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);
    return MaterialApp.router(
      title:           'RetailOS',
      debugShowCheckedModeBanner: false,
      theme:           AppTheme.light,
      darkTheme:       AppTheme.dark,
      themeMode:       ThemeMode.system,
      routerConfig:    router,
    );
  }
}
