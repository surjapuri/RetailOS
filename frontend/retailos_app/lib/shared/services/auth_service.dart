import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:retailos/core/network/api_client.dart';
import 'package:uuid/uuid.dart';

class AuthState {
  final bool isAuthenticated;
  final String? userId;
  final String? storeId;
  final String? role;
  final int roleLevel;
  const AuthState({this.isAuthenticated=false,this.userId,this.storeId,this.role,this.roleLevel=0});
  AuthState copyWith({bool? isAuthenticated,String? userId,String? storeId,String? role,int? roleLevel}) =>
    AuthState(isAuthenticated:isAuthenticated??this.isAuthenticated,userId:userId??this.userId,
              storeId:storeId??this.storeId,role:role??this.role,roleLevel:roleLevel??this.roleLevel);
}

class AuthNotifier extends StateNotifier<AuthState> {
  AuthNotifier() : super(const AuthState()) { _checkAuth(); }
  final _storage = const FlutterSecureStorage();
  final _api     = ApiClient();

  Future<void> _checkAuth() async {
    final token = await _storage.read(key:'access_token');
    if (token == null) return;
    try {
      final r = await _api.get('/auth/me');
      final u = r.data['data'];
      state = AuthState(isAuthenticated:true,userId:u['id'],storeId:u['storeId'],
                        role:u['role'],roleLevel:u['roleLevel']);
    } catch (_) { await _storage.deleteAll(); }
  }

  Future<void> sendOTP(String mobile) async {
    await _api.post('/auth/otp/send', data:{'mobile':mobile});
  }

  Future<void> login(String mobile, String otp) async {
    String? deviceId = await _storage.read(key:'device_id');
    deviceId ??= const Uuid().v4();
    await _storage.write(key:'device_id',value:deviceId);
    final r = await _api.post('/auth/login', data:{'mobile':mobile,'otp':otp});
    final d = r.data['data'];
    await _storage.write(key:'access_token',  value:d['tokens']['accessToken']);
    await _storage.write(key:'refresh_token', value:d['tokens']['refreshToken']);
    final u = d['user'];
    state = AuthState(isAuthenticated:true,userId:u['id'],storeId:u['storeId'],
                      role:u['role'],roleLevel:u['roleLevel']);
  }

  Future<void> logout() async {
    try { await _api.post('/auth/logout'); } catch(_) {}
    await _storage.deleteAll();
    state = const AuthState();
  }

  bool get isAdmin      => state.roleLevel >= 5;
  bool get isHeadCashier=> state.roleLevel >= 4;
  bool get isBuyer      => state.role == 'buyer';
  bool get isFinance    => state.role == 'finance';
}

final authStateProvider = StateNotifierProvider<AuthNotifier,AuthState>((ref) => AuthNotifier());
