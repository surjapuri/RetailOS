import 'package:flutter/material.dart';
class WeightIndicator extends StatelessWidget {
  final double? weight;
  const WeightIndicator({super.key,this.weight});
  @override Widget build(BuildContext ctx) => weight==null ? const SizedBox.shrink()
    : Container(margin:const EdgeInsets.symmetric(horizontal:4,vertical:8),
        padding:const EdgeInsets.symmetric(horizontal:10,vertical:4),
        decoration:BoxDecoration(color:const Color(0xFF10B981).withOpacity(0.15),borderRadius:BorderRadius.circular(6),
          border:Border.all(color:const Color(0xFF10B981),width:1)),
        child:Text('${weight!.toStringAsFixed(3)} kg',style:const TextStyle(color:Color(0xFF10B981),fontSize:12,fontWeight:FontWeight.w700)));
}