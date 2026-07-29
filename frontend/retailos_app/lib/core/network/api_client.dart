import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:retailos/core/constants/api_constants.dart';

class ApiClient {
  static final ApiClient _instance = ApiClient._internal();
  factory ApiClient() => _instance;

  late final Dio _dio;
  final _storage = const FlutterSecureStorage();

  ApiClient._internal() {
    _dio = Dio(BaseOptions(
      baseUrl:        ApiConstants.baseUrl,
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 30),
      headers: {
        'Content-Type': 'application/json',
        'Accept':        'application/json',
      },
    ));
    _dio.interceptors.addAll([
      _AuthInterceptor(_storage),
      _RetryInterceptor(_dio),
      LogInterceptor(requestBody: false, responseBody: false),
    ]);
  }

  Dio get dio => _dio;

  Future<Response<T>> get<T>(String path, {Map<String,dynamic>? params}) =>
    _dio.get<T>(path, queryParameters: params);

  Future<Response<T>> post<T>(String path, {dynamic data}) =>
    _dio.post<T>(path, data: data);

  Future<Response<T>> put<T>(String path, {dynamic data}) =>
    _dio.put<T>(path, data: data);

  Future<Response<T>> patch<T>(String path, {dynamic data}) =>
    _dio.patch<T>(path, data: data);

  Future<Response<T>> delete<T>(String path) =>
    _dio.delete<T>(path);
}

class _AuthInterceptor extends Interceptor {
  final FlutterSecureStorage _storage;
  _AuthInterceptor(this._storage);

  @override
  Future<void> onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    final token = await _storage.read(key: 'access_token');
    if (token != null) options.headers['Authorization'] = 'Bearer \$token';
    final deviceId = await _storage.read(key: 'device_id');
    if (deviceId != null) options.headers['X-Device-ID'] = deviceId;
    handler.next(options);
  }

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    if (err.response?.statusCode == 401) {
      try {
        final refreshToken = await _storage.read(key: 'refresh_token');
        if (refreshToken != null) {
          final dio = Dio(BaseOptions(baseUrl: ApiConstants.baseUrl));
          final res = await dio.post('/auth/refresh', data: {'refreshToken': refreshToken});
          final newToken = res.data['data']['accessToken'];
          await _storage.write(key: 'access_token', value: newToken);
          err.requestOptions.headers['Authorization'] = 'Bearer \$newToken';
          final retryRes = await dio.fetch(err.requestOptions);
          return handler.resolve(retryRes);
        }
      } catch (_) {}
      await _storage.deleteAll();
    }
    handler.next(err);
  }
}

class _RetryInterceptor extends Interceptor {
  final Dio _dio;
  _RetryInterceptor(this._dio);

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    if (err.type == DioExceptionType.connectionTimeout ||
        err.type == DioExceptionType.receiveTimeout) {
      // Single retry after 1 second
      await Future.delayed(const Duration(seconds:1));
      try {
        final res = await _dio.fetch(err.requestOptions);
        return handler.resolve(res);
      } catch (e) {/* ignore and fall through */}
    }
    handler.next(err);
  }
}
