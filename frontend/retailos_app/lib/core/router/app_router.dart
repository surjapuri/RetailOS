import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:retailos/features/auth/screens/splash_screen.dart';
import 'package:retailos/features/auth/screens/login_screen.dart';
import 'package:retailos/features/pos/screens/pos_screen.dart';
import 'package:retailos/features/pos/screens/shift_screen.dart';
import 'package:retailos/features/crm/screens/customer_screen.dart';
import 'package:retailos/features/inventory/screens/inventory_screen.dart';
import 'package:retailos/features/khata/screens/khata_screen.dart';
import 'package:retailos/features/inbox/screens/inbox_screen.dart';
import 'package:retailos/features/geo/screens/discovery_screen.dart';
import 'package:retailos/features/admin/screens/admin_dashboard_screen.dart';
import 'package:retailos/shared/services/auth_service.dart';

final appRouterProvider = Provider<GoRouter>((ref) {
  final authState = ref.watch(authStateProvider);
  return GoRouter(
    initialLocation: '/splash',
    redirect: (ctx, state) {
      final authed = authState.isAuthenticated;
      final onAuth = state.matchedLocation.startsWith('/auth');
      if (!authed && !onAuth && state.matchedLocation != '/splash') return '/auth/login';
      if (authed && onAuth) return '/pos';
      return null;
    },
    routes: [
      GoRoute(path:'/splash',     builder:(c,s)=>const SplashScreen()),
      GoRoute(path:'/auth/login', builder:(c,s)=>const LoginScreen()),
      GoRoute(path:'/pos',        builder:(c,s)=>const POSScreen()),
      GoRoute(path:'/pos/shift',  builder:(c,s)=>const ShiftScreen()),
      GoRoute(path:'/customers',  builder:(c,s)=>const CustomerScreen()),
      GoRoute(path:'/inventory',  builder:(c,s)=>const InventoryScreen()),
      GoRoute(path:'/khata',      builder:(c,s)=>const KhataScreen()),
      GoRoute(path:'/inbox',      builder:(c,s)=>const InboxScreen()),
      GoRoute(path:'/discover',   builder:(c,s)=>const DiscoveryScreen()),
      GoRoute(path:'/admin',      builder:(c,s)=>const AdminDashboardScreen()),
    ],
  );
});
