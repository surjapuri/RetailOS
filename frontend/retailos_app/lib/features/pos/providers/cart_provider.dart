import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';
import 'package:retailos/shared/models/product.dart';
import 'package:retailos/core/network/api_client.dart';
import 'package:retailos/shared/services/local_db_service.dart';
import 'package:retailos/shared/services/offline_sync_service.dart';

class CartState {
  final List<CartItem> items;
  final String? customerId;
  final String? customerName;
  final int     pointsBalance;
  final double  discountAmount;
  final String? linkedShiftId;

  const CartState({this.items=const[],this.customerId,this.customerName,
                   this.pointsBalance=0,this.discountAmount=0,this.linkedShiftId});

  double get subtotal      => items.fold(0,(s,i)=>s+i.lineTotal);
  double get cgstTotal     => items.fold(0,(s,i)=>s+(i.gstAmount/2));
  double get sgstTotal     => cgstTotal;
  double get total         => subtotal - discountAmount;
  int    get itemCount     => items.length;
  bool   get hasCustomer   => customerId != null;

  CartState copyWith({List<CartItem>? items,String? customerId,String? customerName,
                      int? pointsBalance,double? discountAmount,String? linkedShiftId}) =>
    CartState(items:items??this.items,customerId:customerId??this.customerId,
              customerName:customerName??this.customerName,pointsBalance:pointsBalance??this.pointsBalance,
              discountAmount:discountAmount??this.discountAmount,linkedShiftId:linkedShiftId??this.linkedShiftId);
}

class CartNotifier extends StateNotifier<CartState> {
  CartNotifier() : super(const CartState());
  final _api = ApiClient();

  // Server-validated line item build
  Future<void> addByBarcode(String barcode) async {
    try {
      // Try local DB first (offline-first)
      final localData = await LocalDBService.lookupByBarcode(barcode,'__store__');
      if (localData != null) {
        await _addProductFromLocalData(localData, 1.0);
        return;
      }
      final r = await _api.get('/pos/products/lookup', params:{'barcode':barcode});
      await _addProductFromJson(r.data['data'], 1.0);
    } catch(e) { /* show error snackbar */ }
  }

  Future<void> addByPLU(String pluCode, double qty) async {
    try {
      final localData = await LocalDBService.lookupByPLU(pluCode,'__store__');
      if (localData != null) { await _addProductFromLocalData(localData, qty); return; }
      final r = await _api.get('/pos/products/lookup', params:{'plu':pluCode});
      await _addProductFromJson(r.data['data'], qty);
    } catch(e) {}
  }

  Future<void> addProduct(Map<String,dynamic> productJson) async {
    await _addProductFromJson(productJson, 1.0);
  }

  Future<void> _addProductFromJson(Map<String,dynamic> j, double qty) async {
    final p = Product.fromJson(j);
    // Get server-authoritative price + volume discount
    final preview = await _api.post('/pos/line-item/preview',
        data:{'product_id':p.id,'quantity':qty});
    final li = preview.data['data'];
    _upsertItem(p, qty, double.parse(li['effective_price'].toString()),
        li['applied_rule_id'], li['discount_applied']??false, li['discount_label']);
  }

  Future<void> _addProductFromLocalData(Map<String,dynamic> j, double qty) async {
    final p = Product.fromJson(j);
    // Apply local volume rules
    double effectivePrice = p.basePrice;
    String? ruleId;
    bool discountApplied = false;
    final rules = await LocalDBService.getVolumeRules(p.id);
    for (final r in rules) {
      if ((r['min_qty'] as num).toDouble() <= qty) {
        effectivePrice = (r['effective_price'] as num).toDouble();
        ruleId = r['id'] as String?;
        discountApplied = true;
        break;
      }
    }
    _upsertItem(p, qty, effectivePrice, ruleId, discountApplied, null);
  }

  void _upsertItem(Product p, double qty, double price, String? ruleId, bool disc, String? discLabel) {
    final items = [...state.items];
    final idx   = items.indexWhere((i)=>i.product.id==p.id && i.appliedRuleId==ruleId);
    if (idx >= 0 && !p.isLoose) {
      items[idx].quantity += qty;
    } else {
      items.add(CartItem(product:p,quantity:qty,effectivePrice:price,
                         appliedRuleId:ruleId,discountApplied:disc,discountLabel:discLabel));
    }
    state = state.copyWith(items:items);
  }

  void updateQty(int index, double qty) {
    final items = [...state.items];
    if (qty <= 0) { items.removeAt(index); } else { items[index].quantity = qty; }
    state = state.copyWith(items:items);
  }

  void removeItem(int index) {
    final items = [...state.items]..removeAt(index);
    state = state.copyWith(items:items);
  }

  void clear() => state = const CartState();

  Future<void> linkCustomer(String mobile) async {
    try {
      final r = await _api.post('/crm/customers/lookup', data:{'mobile':mobile});
      final c = r.data['data']['customer'];
      final pts = await _api.get('/crm/customers/${c['id']}/points');
      state = state.copyWith(
        customerId:c['id'], customerName:c['name']??mobile,
        pointsBalance:pts.data['data']['balance']??0);
    } catch(e) {}
  }

  // Finalise bill — sends to backend (or saves offline)
  Future<Map<String,dynamic>?> checkout({String? paymentMethod, double? discountAmount, String? discountApprovedBy}) async {
    if (state.items.isEmpty) return null;
    final offlineId = const Uuid().v4();
    final payload   = {
      'offlineId':    offlineId,
      'items':        state.items.map((i)=>{'product_id':i.product.id,'quantity':i.quantity}).toList(),
      'customer_id':  state.customerId,
      'discount_amount':    discountAmount ?? 0,
      'discount_approved_by': discountApprovedBy,
      'shift_id':     state.linkedShiftId,
      'offline_at':   null,
    };
    try {
      final r = await _api.post('/pos/bills', data:payload);
      clear();
      return r.data['data'];
    } catch(e) {
      // Save offline
      await OfflineSyncService.savePendingBill({...payload,'offlineId':offlineId,'offlineAt':DateTime.now().toIso8601String()});
      clear();
      return {'offline':true,'offlineId':offlineId};
    }
  }
}

final cartProvider = StateNotifierProvider<CartNotifier,CartState>((ref)=>CartNotifier());
