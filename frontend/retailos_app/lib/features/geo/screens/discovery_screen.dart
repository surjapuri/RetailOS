import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:geolocator/geolocator.dart';
import 'package:retailos/core/network/api_client.dart';
class DiscoveryScreen extends StatefulWidget {
  const DiscoveryScreen({super.key});
  @override State<DiscoveryScreen> createState() => _DiscoveryScreenState();
}
class _DiscoveryScreenState extends State<DiscoveryScreen> {
  List _stores = []; bool _b2bMode = false; LatLng? _pos;
  @override void initState() { super.initState(); _locate(); }
  Future<void> _locate() async {
    final p = await Geolocator.getCurrentPosition();
    setState(()=>_pos=LatLng(p.latitude,p.longitude));
    final r = await ApiClient().get('/geo/discover',params:{'lat':p.latitude,'lng':p.longitude,'mode':_b2bMode?'b2b':'b2c'});
    setState(()=>_stores=r.data['data']??[]);
  }
  @override Widget build(BuildContext ctx) => Scaffold(
    appBar:AppBar(title:const Text('Discover'),actions:[
      Switch(value:_b2bMode,onChanged:(v){setState(()=>_b2bMode=v);_locate();}),
      Text(_b2bMode?'B2B':'B2C'),const SizedBox(width:12)]),
    body:_pos==null?const Center(child:CircularProgressIndicator()):
    FlutterMap(options:MapOptions(initialCenter:_pos!,initialZoom:14),
      children:[TileLayer(urlTemplate:'https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
        MarkerLayer(markers:_stores.map((s)=>Marker(point:LatLng(s['location']?['lat']??0,s['location']?['lng']??0),
          child:const Icon(Icons.store,color:Color(0xFFF59E0B),size:32))).toList())]));
}