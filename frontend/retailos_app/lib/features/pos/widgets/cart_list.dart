import 'package:flutter/material.dart';
import 'package:retailos/shared/models/product.dart';
class CartList extends StatelessWidget {
  final List<CartItem> items;
  final void Function(int) onRemove;
  final void Function(int,double) onQtyChange;
  const CartList({super.key,required this.items,required this.onRemove,required this.onQtyChange});
  @override Widget build(BuildContext ctx) => items.isEmpty
    ? const Center(child:Column(mainAxisSize:MainAxisSize.min,children:[
        Icon(Icons.shopping_cart_outlined,size:56,color:Colors.grey),
        SizedBox(height:8), Text('Cart is empty',style:TextStyle(color:Colors.grey))]))
    : ListView.builder(padding:const EdgeInsets.all(8),itemCount:items.length,itemBuilder:(ctx,i){
        final item=items[i];
        return Card(child:ListTile(
          title:Text(item.product.name,style:const TextStyle(fontWeight:FontWeight.w600,fontSize:14)),
          subtitle:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
            Text('Rs.${item.effectivePrice.toStringAsFixed(2)} x ${item.quantity} ${item.product.unitType}',style:const TextStyle(fontSize:12)),
            if(item.discountApplied) Text(item.discountLabel??'Offer applied',style:const TextStyle(color:Color(0xFF10B981),fontSize:11)),
          ]),
          trailing:Row(mainAxisSize:MainAxisSize.min,children:[
            Text('Rs.${item.lineTotal.toStringAsFixed(2)}',style:const TextStyle(fontWeight:FontWeight.w700)),
            const SizedBox(width:4),
            IconButton(icon:const Icon(Icons.close,size:18,color:Colors.red),onPressed:()=>onRemove(i)),
          ]),
          contentPadding:const EdgeInsets.symmetric(horizontal:14,vertical:4)));
      });
}