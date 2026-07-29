import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:retailos/shared/services/auth_service.dart';
import 'package:retailos/core/theme/app_theme.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});
  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _mobileCtrl  = TextEditingController();
  final _otpCtrl     = TextEditingController();
  bool  _otpSent     = false;
  bool  _loading     = false;
  String? _error;

  @override
  void dispose() { _mobileCtrl.dispose(); _otpCtrl.dispose(); super.dispose(); }

  Future<void> _sendOTP() async {
    if (_mobileCtrl.text.length != 10) {
      setState((){ _error='Enter a valid 10-digit mobile number'; });
      return;
    }
    setState((){ _loading=true; _error=null; });
    try {
      await ref.read(authStateProvider.notifier).sendOTP(_mobileCtrl.text.trim());
      setState((){ _otpSent=true; _loading=false; });
    } catch(e) {
      setState((){ _loading=false; _error=e.toString(); });
    }
  }

  Future<void> _login() async {
    if (_otpCtrl.text.length != 6) {
      setState((){ _error='Enter the 6-digit OTP'; }); return;
    }
    setState((){ _loading=true; _error=null; });
    try {
      await ref.read(authStateProvider.notifier).login(_mobileCtrl.text.trim(),_otpCtrl.text.trim());
      if (mounted) context.go('/pos');
    } catch(e) {
      setState((){ _loading=false; _error='Invalid OTP. Please try again.'; });
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: AppTheme.dark_bg,
    body: SafeArea(child: Padding(
      padding:const EdgeInsets.symmetric(horizontal:28),
      child: Column(crossAxisAlignment:CrossAxisAlignment.start, children:[
        const SizedBox(height:60),
        const Text('Retail', style:TextStyle(fontSize:38,fontWeight:FontWeight.w900,color:Colors.white)),
        const Text('OS', style:TextStyle(fontSize:38,fontWeight:FontWeight.w900,color:Color(0xFFF59E0B))),
        const SizedBox(height:6),
        const Text('The Kirana Super-App', style:TextStyle(color:Colors.grey,fontSize:15)),
        const Spacer(),
        Text(_otpSent ? 'Enter OTP' : 'Login', style:const TextStyle(color:Colors.white,fontSize:24,fontWeight:FontWeight.w700)),
        const SizedBox(height:6),
        Text(_otpSent ? 'Sent to +91 ${_mobileCtrl.text}' : 'Enter your mobile number',
             style:const TextStyle(color:Colors.grey,fontSize:14)),
        const SizedBox(height:28),
        if (!_otpSent) ...[
          TextField(
            controller:_mobileCtrl, keyboardType:TextInputType.phone,
            maxLength:10,
            style:const TextStyle(color:Colors.white,fontSize:18,letterSpacing:2),
            decoration:InputDecoration(
              prefixText:'+91  ', prefixStyle:const TextStyle(color:Colors.grey),
              counterText:'',
              fillColor:const Color(0xFF1E293B), filled:true,
              border:OutlineInputBorder(borderRadius:BorderRadius.circular(12), borderSide:BorderSide.none),
            ),
          ),
          const SizedBox(height:14),
          SizedBox(width:double.infinity,
            child:ElevatedButton(
              onPressed:_loading ? null : _sendOTP,
              child:_loading ? const SizedBox(width:22,height:22,child:CircularProgressIndicator(strokeWidth:2,color:Colors.white))
                             : const Text('Send OTP', style:TextStyle(fontSize:16)),
            )),
        ] else ...[
          TextField(
            controller:_otpCtrl, keyboardType:TextInputType.number,
            maxLength:6, autofocus:true,
            style:const TextStyle(color:Colors.white,fontSize:28,letterSpacing:10),
            textAlign:TextAlign.center,
            decoration:InputDecoration(
              counterText:'',
              fillColor:const Color(0xFF1E293B), filled:true,
              border:OutlineInputBorder(borderRadius:BorderRadius.circular(12), borderSide:BorderSide.none),
            ),
          ),
          const SizedBox(height:14),
          SizedBox(width:double.infinity,
            child:ElevatedButton(
              onPressed:_loading ? null : _login,
              child:_loading ? const SizedBox(width:22,height:22,child:CircularProgressIndicator(strokeWidth:2,color:Colors.white))
                             : const Text('Login', style:TextStyle(fontSize:16)),
            )),
          const SizedBox(height:10),
          TextButton(
            onPressed:()=> setState((){_otpSent=false;_otpCtrl.clear();}),
            child:const Text('Change number', style:TextStyle(color:Colors.grey))),
        ],
        if (_error != null) ...[
          const SizedBox(height:12),
          Text(_error!, style:const TextStyle(color:Color(0xFFF43F5E),fontSize:13)),
        ],
        const Spacer(),
      ]),
    )),
  );
}
