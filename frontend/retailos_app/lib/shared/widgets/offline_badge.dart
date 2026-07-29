import 'package:flutter/material.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
class OfflineBadge extends StatelessWidget {
  const OfflineBadge({super.key});
  @override Widget build(BuildContext ctx) => StreamBuilder<ConnectivityResult>(
    stream:Connectivity().onConnectivityChanged,
    builder:(ctx,snap)=> snap.data==ConnectivityResult.none
      ? Container(margin:const EdgeInsets.symmetric(horizontal:4,vertical:8),
          padding:const EdgeInsets.symmetric(horizontal:8,vertical:4),
          decoration:BoxDecoration(color:const Color(0xFFF43F5E),borderRadius:BorderRadius.circular(6)),
          child:const Text('OFFLINE',style:TextStyle(color:Colors.white,fontSize:11,fontWeight:FontWeight.w700)))
      : const SizedBox.shrink());
}