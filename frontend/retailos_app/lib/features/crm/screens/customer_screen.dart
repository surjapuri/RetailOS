import 'package:flutter/material.dart';
import 'package:retailos/core/network/api_client.dart';
class CustomerScreen extends StatelessWidget {
  const CustomerScreen({super.key});
  @override Widget build(BuildContext ctx) =>
    Scaffold(appBar:AppBar(title:const Text('Customers')),body:const Center(child:Text('Customer Management')));
}