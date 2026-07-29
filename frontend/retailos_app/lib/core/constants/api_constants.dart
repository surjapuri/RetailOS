class ApiConstants {
  static const baseUrl = String.fromEnvironment(
    'API_BASE_URL', defaultValue: 'https://api.retailos.app/api/v1');
  static const wsUrl  = String.fromEnvironment(
    'WS_URL', defaultValue: 'wss://api.retailos.app');
}
