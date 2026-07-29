import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:retailos/core/network/api_client.dart';
import 'package:timeago/timeago.dart' as timeago;
import 'package:url_launcher/url_launcher.dart';

class InboxScreen extends ConsumerStatefulWidget {
  final String customerId;
  final String storeId;
  const InboxScreen({super.key, required this.customerId, required this.storeId});
  @override
  ConsumerState<InboxScreen> createState() => _InboxScreenState();
}

class _InboxScreenState extends ConsumerState<InboxScreen> {
  List<dynamic> _messages = [];
  int  _unread = 0;
  bool _loading = true;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    final api = ApiClient();
    final r   = await api.get('/crm/customers/${widget.customerId}/inbox');
    setState((){
      _messages = r.data['data']['messages'] ?? [];
      _unread   = r.data['data']['unread']   ?? 0;
      _loading  = false;
    });
  }

  IconData _iconFor(String type) {
    switch(type) {
      case 'receipt':          return Icons.receipt_long;
      case 'points':           return Icons.star;
      case 'offer':            return Icons.local_offer;
      case 'khata':            return Icons.account_balance_wallet;
      case 'reorder':          return Icons.shopping_cart;
      case 'platform_credit':  return Icons.card_giftcard;
      default:                 return Icons.notifications;
    }
  }

  Color _colorFor(String type) {
    switch(type) {
      case 'receipt':         return const Color(0xFF38BDF8);
      case 'points':          return const Color(0xFFF59E0B);
      case 'offer':           return const Color(0xFF10B981);
      case 'khata':           return const Color(0xFFF43F5E);
      case 'reorder':         return const Color(0xFF8B5CF6);
      case 'platform_credit': return const Color(0xFF84CC16);
      default:                return Colors.grey;
    }
  }

  @override
  Widget build(BuildContext ctx) => Scaffold(
    appBar: AppBar(
      title:Row(children:[
        const Text('Inbox'),
        if (_unread > 0) ...[
          const SizedBox(width:8),
          Container(padding:const EdgeInsets.symmetric(horizontal:8,vertical:2),
            decoration:BoxDecoration(color:const Color(0xFFF43F5E),borderRadius:BorderRadius.circular(100)),
            child:Text('$_unread', style:const TextStyle(color:Colors.white,fontSize:12,fontWeight:FontWeight.w700))),
        ],
      ]),
    ),
    body: _loading
      ? const Center(child:CircularProgressIndicator())
      : _messages.isEmpty
        ? const Center(child:Column(mainAxisSize:MainAxisSize.min,children:[
            Icon(Icons.inbox, size:56, color:Colors.grey),
            SizedBox(height:10),
            Text('No messages yet', style:TextStyle(color:Colors.grey)),
          ]))
        : RefreshIndicator(
            onRefresh:_load,
            child:ListView.builder(
              padding:const EdgeInsets.all(12),
              itemCount:_messages.length,
              itemBuilder:(ctx,i){
                final m    = _messages[i];
                final type = m['msg_type'] as String? ?? '';
                final read = m['is_read'] == true;
                final date = DateTime.tryParse(m['created_at']??'') ?? DateTime.now();
                return Card(
                  margin:const EdgeInsets.only(bottom:10),
                  color:read ? null : Colors.white,
                  elevation:read ? 0 : 2,
                  child:ListTile(
                    leading:Container(
                      width:42,height:42,
                      decoration:BoxDecoration(color:_colorFor(type).withOpacity(0.15),shape:BoxShape.circle),
                      child:Icon(_iconFor(type),color:_colorFor(type),size:20)),
                    title:Text(m['title']??'', style:TextStyle(fontWeight:read?FontWeight.w400:FontWeight.w700,fontSize:14)),
                    subtitle:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
                      const SizedBox(height:2),
                      Text(m['body']??'',style:const TextStyle(fontSize:12,color:Colors.grey),maxLines:2,overflow:TextOverflow.ellipsis),
                      const SizedBox(height:4),
                      Text(timeago.format(date),style:const TextStyle(fontSize:11,color:Colors.grey)),
                    ]),
                    trailing:m['action_url']!=null
                      ? IconButton(icon:const Icon(Icons.download,size:18),
                          onPressed:()=> launchUrl(Uri.parse(m['action_url'])))
                      : null,
                    contentPadding:const EdgeInsets.symmetric(horizontal:14,vertical:8),
                  ),
                );
              },
            ),
          ),
  );
}
