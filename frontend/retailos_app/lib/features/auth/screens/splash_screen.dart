import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:retailos/shared/services/auth_service.dart';
class SplashScreen extends ConsumerWidget {
  const SplashScreen({super.key});
  @override Widget build(BuildContext ctx, WidgetRef ref) {
    Future.delayed(const Duration(milliseconds:800), () {
      final auth = ref.read(authStateProvider);
      ctx.go(auth.isAuthenticated ? '/pos' : '/auth/login');
    });
    return const Scaffold(backgroundColor:Color(0xFF0F172A),
      body:Center(child:Column(mainAxisSize:MainAxisSize.min,children:[
        Text('Retail',style:TextStyle(fontSize:44,fontWeight:FontWeight.w900,color:Colors.white)),
        Text('OS',    style:TextStyle(fontSize:44,fontWeight:FontWeight.w900,color:Color(0xFFF59E0B))),
        SizedBox(height:32),
        CircularProgressIndicator(color:Color(0xFFF59E0B)),
      ])));
  }
}