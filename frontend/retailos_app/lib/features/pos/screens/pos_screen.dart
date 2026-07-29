import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:retailos/features/pos/providers/cart_provider.dart';
import 'package:retailos/features/pos/providers/pos_provider.dart';
import 'package:retailos/features/pos/widgets/cart_list.dart';
import 'package:retailos/features/pos/widgets/product_search_bar.dart';
import 'package:retailos/features/pos/widgets/bill_summary.dart';
import 'package:retailos/features/pos/widgets/payment_bottom_sheet.dart';
import 'package:retailos/features/pos/widgets/weight_indicator.dart';
import 'package:retailos/shared/widgets/offline_badge.dart';
import 'package:retailos/core/theme/app_theme.dart';

class POSScreen extends ConsumerStatefulWidget {
  const POSScreen({super.key});
  @override
  ConsumerState<POSScreen> createState() => _POSScreenState();
}

class _POSScreenState extends ConsumerState<POSScreen> {
  final _scanController = TextEditingController();
  final _scanFocus      = FocusNode();
  final _barcodeBuffer  = StringBuffer();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(posProvider.notifier).init();
      _scanFocus.requestFocus();
    });
  }

  @override
  void dispose() {
    _scanController.dispose();
    _scanFocus.dispose();
    super.dispose();
  }

  void _onBarcodeScanned(String barcode) {
    if (barcode.isEmpty) return;
    ref.read(cartProvider.notifier).addByBarcode(barcode.trim());
    _scanController.clear();
    _scanFocus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final cart    = ref.watch(cartProvider);
    final posState= ref.watch(posProvider);
    final isLandscape = MediaQuery.of(context).orientation == Orientation.landscape;

    return KeyboardListener(
      focusNode:  _scanFocus,
      autofocus:  true,
      onKeyEvent: (e) {
        if (e is KeyDownEvent) {
          if (e.logicalKey == LogicalKeyboardKey.enter) {
            _onBarcodeScanned(_barcodeBuffer.toString());
            _barcodeBuffer.clear();
          } else {
            final char = e.character;
            if (char != null && char.isNotEmpty) _barcodeBuffer.write(char);
          }
        }
      },
      child: Scaffold(
        backgroundColor: const Color(0xFFF1F5F9),
        appBar: _buildAppBar(context, posState),
        body: isLandscape
          ? Row(children:[
              Expanded(flex:3, child:_leftPanel(context, cart)),
              Expanded(flex:2, child:_rightPanel(context, cart)),
            ])
          : Column(children:[
              Expanded(child:_leftPanel(context, cart)),
              _rightPanel(context, cart),
            ]),
      ),
    );
  }

  PreferredSizeWidget _buildAppBar(BuildContext ctx, POSState posState) =>
    AppBar(
      title: Column(crossAxisAlignment:CrossAxisAlignment.start, children:[
        const Text('RetailOS POS'),
        if (posState.shiftId != null)
          Text('Shift: ${posState.cashierId?.substring(0,8)}...', style:const TextStyle(fontSize:11,color:Colors.grey)),
      ]),
      actions: [
        const OfflineBadge(),
        const WeightIndicator(),
        IconButton(icon:const Icon(Icons.person_outline), onPressed:()=>_openCustomerSearch(ctx)),
        IconButton(icon:const Icon(Icons.receipt_long), onPressed:(){}),
        IconButton(icon:const Icon(Icons.more_vert), onPressed:()=>_showMenu(ctx)),
      ],
    );

  Widget _leftPanel(BuildContext ctx, CartState cart) => Column(children:[
    ProductSearchBar(onProductSelected:(p)=> ref.read(cartProvider.notifier).addProduct(p)),
    Expanded(child: CartList(
      items:    cart.items,
      onRemove: (i) => ref.read(cartProvider.notifier).removeItem(i),
      onQtyChange:(i,qty) => ref.read(cartProvider.notifier).updateQty(i,qty),
    )),
  ]);

  Widget _rightPanel(BuildContext ctx, CartState cart) => Container(
    color:Colors.white,
    padding:const EdgeInsets.all(16),
    child: Column(children:[
      BillSummary(cart:cart),
      const SizedBox(height:12),
      if (cart.items.isNotEmpty) ...[
        ElevatedButton.icon(
          icon:const Icon(Icons.payment),
          label:Text('Pay Rs.${cart.total.toStringAsFixed(2)}', style:const TextStyle(fontSize:17)),
          style:ElevatedButton.styleFrom(
            minimumSize:const Size.fromHeight(54),
            backgroundColor:AppTheme.primary,
          ),
          onPressed:()=> showModalBottomSheet(
            context:ctx, isScrollControlled:true, useSafeArea:true,
            builder:(_)=> PaymentBottomSheet(total:cart.total, cartState:cart)),
        ),
        const SizedBox(height:8),
        OutlinedButton.icon(
          icon:const Icon(Icons.delete_outline, color:Colors.red),
          label:const Text('Clear Cart', style:TextStyle(color:Colors.red)),
          style:OutlinedButton.styleFrom(minimumSize:const Size.fromHeight(44),
            side:const BorderSide(color:Colors.red)),
          onPressed:()=> ref.read(cartProvider.notifier).clear(),
        ),
      ],
    ]),
  );

  void _openCustomerSearch(BuildContext ctx) {
    showDialog(context:ctx, builder:(_)=> AlertDialog(
      title:const Text('Link Customer'),
      content:TextField(
        autofocus:true,
        keyboardType:TextInputType.phone,
        decoration:const InputDecoration(labelText:'Mobile Number',hintText:'10-digit mobile'),
        onSubmitted:(mob)async{
          Navigator.pop(ctx);
          await ref.read(cartProvider.notifier).linkCustomer(mob);
        },
      ),
    ));
  }

  void _showMenu(BuildContext ctx) {
    showModalBottomSheet(context:ctx, builder:(_)=> SafeArea(child:Column(mainAxisSize:MainAxisSize.min, children:[
      ListTile(leading:const Icon(Icons.timer),          title:const Text('Shift Management'), onTap:(){}),
      ListTile(leading:const Icon(Icons.inventory_2),    title:const Text('Inventory'),        onTap:(){}),
      ListTile(leading:const Icon(Icons.people),         title:const Text('Customers'),        onTap:(){}),
      ListTile(leading:const Icon(Icons.account_balance_wallet), title:const Text('Khata Ledger'), onTap:(){}),
      ListTile(leading:const Icon(Icons.settings),       title:const Text('Settings'),         onTap:(){}),
    ])));
  }
}
