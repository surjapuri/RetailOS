import 'dart:async';
import 'dart:isolate';
import 'dart:convert';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:sqflite/sqflite.dart';
import 'package:retailos/core/network/api_client.dart';
import 'package:retailos/shared/services/local_db_service.dart';

class OfflineSyncService {
  static Timer? _timer;

  static void startBackgroundSync() {
    Connectivity().onConnectivityChanged.listen((status) {
      if (status != ConnectivityResult.none) _syncPendingBills();
    });
    _timer = Timer.periodic(const Duration(minutes:5), (_) => _syncPendingBills());
  }

  static Future<void> _syncPendingBills() async {
    final db     = await LocalDBService.instance;
    final pending = await db.query('pending_sync_queue',
        where:'sync_status=?', whereArgs:['pending'], limit:50);
    if (pending.isEmpty) return;

    try {
      final bills = pending.map((r) => jsonDecode(r['payload'] as String)).toList();
      final api   = ApiClient();
      final res   = await api.post('/sync/bills', data:{'bills':bills});
      final synced  = res.data['data']['synced'] as List? ?? [];
      final failed  = res.data['data']['failed'] as List? ?? [];
      final dupes   = res.data['data']['duplicates'] as List? ?? [];

      final allDone = {...synced.map((s)=>s['offlineId']), ...dupes};
      for (final id in allDone) {
        await db.update('pending_sync_queue', {'sync_status':'synced','synced_at':DateTime.now().toIso8601String()},
            where:'id=?', whereArgs:[id]);
      }
      for (final f in failed) {
        await db.rawUpdate(
          'UPDATE pending_sync_queue SET retry_count=retry_count+1, last_error=? WHERE id=?',
          [f['error'], f['offlineId']]);
      }
    } catch (e) { /* will retry on next sync */ }
  }

  static Future<void> savePendingBill(Map<String,dynamic> bill) async {
    final db = await LocalDBService.instance;
    await db.insert('pending_sync_queue', {
      'id':          bill['offlineId'],
      'payload':     jsonEncode(bill),
      'sync_status': 'pending',
      'created_offline_at': DateTime.now().toIso8601String(),
    }, conflictAlgorithm: ConflictAlgorithm.ignore);
  }
}
