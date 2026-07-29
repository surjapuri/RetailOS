import 'package:flutter/material.dart';
import 'package:retailos/features/pos/providers/cart_provider.dart';
class BillSummary extends StatelessWidget {
  final CartState cart;
  const BillSummary({super.key,required this.cart});
  @override Widget build(BuildContext ctx) => Column(children:[
    if(cart.hasCustomer) Container(width:double.infinity,padding:const EdgeInsets.all(10),
      decoration:BoxDecoration(color:const Color(0xFF10B981).withOpacity(0.1),borderRadius:BorderRadius.circular(8)),
      child:Text('Customer: ${cart.customerName} | Points: ${cart.pointsBalance}',style:const TextStyle(fontSize:13,fontWeight:FontWeight.w600))),
    const SizedBox(height:8),
    Row(mainAxisAlignment:MainAxisAlignment.spaceBetween,children:[const Text('Items'),Text('${cart.itemCount}')]),
    Row(mainAxisAlignment:MainAxisAlignment.spaceBetween,children:[const Text('Subtotal'),Text('Rs.${cart.subtotal.toStringAsFixed(2)}')]),
    Row(mainAxisAlignment:MainAxisAlignment.spaceBetween,children:[const Text('CGST'),Text('Rs.${cart.cgstTotal.toStringAsFixed(2)}')]),
    Row(mainAxisAlignment:MainAxisAlignment.spaceBetween,children:[const Text('SGST'),Text('Rs.${cart.sgstTotal.toStringAsFixed(2)}')]),
    const Divider(),
    Row(mainAxisAlignment:MainAxisAlignment.spaceBetween,children:[
      const Text('TOTAL',style:TextStyle(fontWeight:FontWeight.w800,fontSize:16)),
      Text('Rs.${cart.total.toStringAsFixed(2)}',style:const TextStyle(fontWeight:FontWeight.w800,fontSize:18,color:Color(0xFFF59E0B))),
    ]),
  ]);
}