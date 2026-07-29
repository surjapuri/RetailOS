import 'package:flutter/material.dart';
import 'package:retailos/core/network/api_client.dart';
class ProductSearchBar extends StatefulWidget {
  final void Function(Map<String,dynamic>) onProductSelected;
  const ProductSearchBar({super.key,required this.onProductSelected});
  @override State<ProductSearchBar> createState() => _ProductSearchBarState();
}
class _ProductSearchBarState extends State<ProductSearchBar> {
  final _ctrl = TextEditingController();
  List _results = [];
  Future<void> _search(String q) async {
    if(q.length<2){setState(()=>_results=[]);return;}
    final r = await ApiClient().get('/pos/products/lookup',params:{'q':q});
    setState(()=>_results=(r.data['data'] is List)?r.data['data']:[]);
  }
  @override Widget build(BuildContext ctx) => Column(children:[
    Padding(padding:const EdgeInsets.all(8),child:TextField(controller:_ctrl,
      decoration:const InputDecoration(hintText:'Search product or scan barcode...',prefixIcon:Icon(Icons.search),),
      onChanged:_search)),
    if(_results.isNotEmpty) Container(height:160,child:ListView(children:_results.map((p)=>ListTile(
      title:Text(p['name'],style:const TextStyle(fontSize:13)),
      subtitle:Text('Rs.${p['base_price']}',style:const TextStyle(fontSize:12)),
      onTap:(){widget.onProductSelected(p);_ctrl.clear();setState(()=>_results=[]);})).toList())),
  ]);
}