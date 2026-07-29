import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

class AppTheme {
  static const _saffron    = Color(0xFFF59E0B);
  static const _mint       = Color(0xFF10B981);
  static const _navy       = Color(0xFF0F172A);
  static const _coral      = Color(0xFFF43F5E);
  static const _cardLight  = Color(0xFFF8FAFC);
  static const _cardDark   = Color(0xFF1E293B);

  static final light = ThemeData(
    useMaterial3:    true,
    colorScheme:     ColorScheme.fromSeed(seedColor:_saffron, brightness:Brightness.light),
    textTheme:       GoogleFonts.interTextTheme(),
    scaffoldBackgroundColor: const Color(0xFFF1F5F9),
    cardTheme: CardTheme(
      color: Colors.white, elevation:0,
      shape: RoundedRectangleBorder(borderRadius:BorderRadius.circular(12)),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: Colors.white, elevation:0,
      titleTextStyle: GoogleFonts.inter(fontSize:17, fontWeight:FontWeight.w700, color:_navy),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled:true, fillColor:_cardLight,
      border:OutlineInputBorder(borderRadius:BorderRadius.circular(10), borderSide:BorderSide.none),
      contentPadding:const EdgeInsets.symmetric(horizontal:16, vertical:14),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: _saffron, foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(50),
        shape: RoundedRectangleBorder(borderRadius:BorderRadius.circular(10)),
        textStyle: GoogleFonts.inter(fontSize:15, fontWeight:FontWeight.w600),
      ),
    ),
  );

  static final dark = ThemeData(
    useMaterial3:    true,
    colorScheme:     ColorScheme.fromSeed(seedColor:_saffron, brightness:Brightness.dark),
    textTheme:       GoogleFonts.interTextTheme(ThemeData.dark().textTheme),
    scaffoldBackgroundColor: _navy,
    cardTheme: CardTheme(
      color:_cardDark, elevation:0,
      shape:RoundedRectangleBorder(borderRadius:BorderRadius.circular(12)),
    ),
  );

  static const primary  = _saffron;
  static const success  = _mint;
  static const error    = _coral;
  static const dark_bg  = _navy;
}
