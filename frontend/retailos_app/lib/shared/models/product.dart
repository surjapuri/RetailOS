class Product {
  final String id;
  final String name;
  final String? barcode;
  final String? pluCode;
  final double basePrice;
  final double? mrp;
  final String? hsnCode;
  final double gstRate;
  final String unitType;
  final bool isLoose;
  final bool isPriceLocked;
  double stockQty;

  Product({required this.id,required this.name,this.barcode,this.pluCode,
           required this.basePrice,this.mrp,this.hsnCode,this.gstRate=0,
           this.unitType='piece',this.isLoose=false,this.isPriceLocked=true,this.stockQty=0});

  factory Product.fromJson(Map<String,dynamic> j) => Product(
    id:j['id'],name:j['name'],barcode:j['barcode'],pluCode:j['plu_code'],
    basePrice:double.parse(j['base_price'].toString()),mrp:j['mrp']!=null?double.parse(j['mrp'].toString()):null,
    hsnCode:j['hsn_code'],gstRate:double.parse((j['gst_rate']??0).toString()),
    unitType:j['unit_type']??'piece',isLoose:j['is_loose']??false,
    isPriceLocked:j['is_price_locked']??true,stockQty:double.parse((j['stock_qty']??0).toString()));

  Map<String,dynamic> toJson() => {'id':id,'name':name,'barcode':barcode,'plu_code':pluCode,
    'base_price':basePrice,'mrp':mrp,'hsn_code':hsnCode,'gst_rate':gstRate,
    'unit_type':unitType,'is_loose':isLoose,'is_price_locked':isPriceLocked,'stock_qty':stockQty};
}

class CartItem {
  final Product product;
  double quantity;
  double effectivePrice;
  String? appliedRuleId;
  bool discountApplied;
  String? discountLabel;

  CartItem({required this.product,this.quantity=1,required this.effectivePrice,
            this.appliedRuleId,this.discountApplied=false,this.discountLabel});

  double get lineTotal => effectivePrice * quantity;
  double get gstAmount => lineTotal - (lineTotal / (1 + product.gstRate / 100));
  double get taxableAmount => lineTotal - gstAmount;

  factory CartItem.fromLineItemJson(Map<String,dynamic> j, Product product) => CartItem(
    product:product, quantity:double.parse(j['quantity'].toString()),
    effectivePrice:double.parse(j['effective_price'].toString()),
    appliedRuleId:j['applied_rule_id'], discountApplied:j['discount_applied']??false,
    discountLabel:j['discount_label']);
}
