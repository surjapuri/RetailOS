import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:retailos/features/pos/providers/cart_provider.dart';
class PaymentBottomSheet extends ConsumerWidget {
  final double total; final CartState cartState;
  const PaymentBottomSheet({super.key,required this.total,required this.cartState});
  @override Widget build(BuildContext ctx, WidgetRef ref) => Container(
    padding:const EdgeInsets.all(24),
    child:Column(mainAxisSize:MainAxisSize.min,children:[
      Container(width:40,height:4,decoration:BoxDecoration(color:Colors.grey[300],borderRadius:BorderRadius.circular(2))),
      const SizedBox(height:20),
      Text('Total: Rs.${total.toStringAsFixed(2)}',style:const TextStyle(fontSize:22,fontWeight:FontWeight.w800)),
      const SizedBox(height:24),
      const Text('Select Payment Method',style:TextStyle(color:Colors.grey)),
      const SizedBox(height:16),
      Row(children:[
        _PayBtn(label:'UPI/QR',icon:Icons.qr_code,color:const Color(0xFF8B5CF6),onTap:()=>_upi(ctx,ref)),
        const SizedBox(width:12),
        _PayBtn(label:'Cash',icon:Icons.money,color:const Color(0xFF10B981),onTap:()=>_cash(ctx,ref)),
        const SizedBox(width:12),
        _PayBtn(label:'Card',icon:Icons.credit_card,color:const Color(0xFF38BDF8),onTap:()=>_card(ctx,ref)),
        const SizedBox(width:12),
        _PayBtn(label:'Khata',icon:Icons.account_balance_wallet,color:const Color(0xFFF43F5E),onTap:()=>_khata(ctx,ref)),
      ]),
    ]));
  void _upi(BuildContext ctx,WidgetRef ref) { Navigator.pop(ctx); ref.read(cartProvider.notifier).checkout(paymentMethod:'upi'); }
  void _cash(BuildContext ctx,WidgetRef ref) { Navigator.pop(ctx); ref.read(cartProvider.notifier).checkout(paymentMethod:'cash'); }
  void _card(BuildContext ctx,WidgetRef ref) { Navigator.pop(ctx); ref.read(cartProvider.notifier).checkout(paymentMethod:'card'); }
  void _khata(BuildContext ctx,WidgetRef ref) { Navigator.pop(ctx); ref.read(cartProvider.notifier).checkout(paymentMethod:'khata'); }
}
class _PayBtn extends StatelessWidget {
  final String label; final IconData icon; final Color color; final VoidCallback onTap;
  const _PayBtn({required this.label,required this.icon,required this.color,required this.onTap});
  @override Widget build(BuildContext ctx) => Expanded(child:GestureDetector(onTap:onTap,
    child:Container(padding:const EdgeInsets.symmetric(vertical:14),
      decoration:BoxDecoration(color:color.withOpacity(0.12),borderRadius:BorderRadius.circular(10),border:Border.all(color:color.withOpacity(0.4))),
      child:Column(children:[Icon(icon,color:color,size:22),const SizedBox(height:4),
        Text(label,style:TextStyle(color:color,fontSize:11,fontWeight:FontWeight.w600))]))));
}