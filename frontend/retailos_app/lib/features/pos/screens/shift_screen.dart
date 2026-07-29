import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:retailos/features/pos/providers/pos_provider.dart';
class ShiftScreen extends ConsumerWidget {
  const ShiftScreen({super.key});
  @override Widget build(BuildContext ctx, WidgetRef ref) {
    final pos = ref.watch(posProvider);
    return Scaffold(appBar:AppBar(title:const Text('Shift Management')),
      body:Center(child:pos.shiftId==null
        ? ElevatedButton(onPressed:()=>ref.read(posProvider.notifier).openShift(500),child:const Text('Open Shift'))
        : ElevatedButton(onPressed:()=>ref.read(posProvider.notifier).closeShift(500),child:const Text('Close Shift'))));
  }
}