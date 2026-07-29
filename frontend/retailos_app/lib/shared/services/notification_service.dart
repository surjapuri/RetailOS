import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

class NotificationService {
  static final _flnp = FlutterLocalNotificationsPlugin();
  static final _fcm  = FirebaseMessaging.instance;

  static Future<void> init() async {
    await _fcm.requestPermission(alert:true,badge:true,sound:true);
    const android = AndroidInitializationSettings('@mipmap/ic_launcher');
    const ios     = DarwinInitializationSettings();
    await _flnp.initialize(const InitializationSettings(android:android,iOS:ios),
        onDidReceiveNotificationResponse:_onTap);
    FirebaseMessaging.onMessage.listen(_handleForeground);
    FirebaseMessaging.onBackgroundMessage(_handleBackground);
    final token = await _fcm.getToken();
    if (token != null) _sendTokenToServer(token);
    _fcm.onTokenRefresh.listen(_sendTokenToServer);
  }

  static Future<void> _handleForeground(RemoteMessage msg) async {
    final n = msg.notification;
    if (n == null) return;
    await _flnp.show(msg.hashCode, n.title, n.body,
      const NotificationDetails(
        android:AndroidNotificationDetails('retailos_main','RetailOS',importance:Importance.high,priority:Priority.high),
        iOS:DarwinNotificationDetails()));
  }

  @pragma('vm:entry-point')
  static Future<void> _handleBackground(RemoteMessage msg) async {}

  static void _onTap(NotificationResponse r) {}

  static Future<void> _sendTokenToServer(String token) async {
    try {
      final api = ApiClient();
      await api.patch('/auth/fcm-token', data:{'fcm_token':token});
    } catch(_) {}
  }
}

// Import ApiClient only here to avoid circular imports
import 'package:retailos/core/network/api_client.dart';
