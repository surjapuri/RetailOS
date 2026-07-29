import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:retailos/core/network/api_client.dart';
import 'package:retailos/shared/services/local_db_service.dart';

class POSState {
  final String? shiftId;
  final String? cashierId;
  final bool    isOnline;
  final DateTime? lastSyncAt;
  const POSState({this.shiftId,this.cashierId,this.isOnline=true,this.lastSyncAt});
  POSState copyWith({String? shiftId,String? cashierId,bool? isOnline,DateTime? lastSyncAt}) =>
    POSState(shiftId:shiftId??this.shiftId,cashierId:cashierId??this.cashierId,
              isOnline:isOnline??this.isOnline,lastSyncAt:lastSyncAt??this.lastSyncAt);
}

class POSNotifier extends StateNotifier<POSState> {
  POSNotifier() : super(const POSState());
  final _api = ApiClient();

  Future<void> init() async {
    await _syncCatalog();
    await _loadActiveShift();
  }

  Future<void> _syncCatalog() async {
    try {
      final since = state.lastSyncAt?.toIso8601String() ?? '2000-01-01T00:00:00Z';
      final r     = await _api.get('/sync/catalog', params:{'since':since});
      final data  = r.data['data'];
      await LocalDBService.upsertProducts(List<Map<String,dynamic>>.from(data['products']??[]));
      await LocalDBService.upsertVolumeRules(List<Map<String,dynamic>>.from(data['volume_rules']??[]));
      state = state.copyWith(isOnline:true, lastSyncAt:DateTime.now());
    } catch(_) { state = state.copyWith(isOnline:false); }
  }

  Future<void> _loadActiveShift() async {
    try {
      final r = await _api.get('/pos/shifts/current');
      final shift = r.data['data'];
      if (shift != null) state = state.copyWith(shiftId:shift['id']);
    } catch(_) {}
  }

  Future<void> openShift(double openingCash) async {
    final r = await _api.post('/pos/shifts/open', data:{'opening_cash':openingCash});
    state = state.copyWith(shiftId:r.data['data']['id']);
  }

  Future<Map<String,dynamic>> closeShift(double closingCash) async {
    final r = await _api.post('/pos/shifts/${state.shiftId}/close', data:{'closing_cash':closingCash});
    state = state.copyWith(shiftId:null);
    return r.data['data'];
  }
}

final posProvider = StateNotifierProvider<POSNotifier,POSState>((ref)=>POSNotifier());
