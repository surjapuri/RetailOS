import 'package:sqflite/sqflite.dart';
import 'package:path/path.dart';

class LocalDBService {
  static Database? _db;

  static Future<Database> get instance async {
    _db ??= await _initDB();
    return _db!;
  }

  static Future<Database> _initDB() async {
    final path = join(await getDatabasesPath(), 'retailos_v2.db');
    return openDatabase(path, version:3, onCreate:_onCreate, onUpgrade:_onUpgrade);
  }

  static Future<void> _onCreate(Database db, int version) async {
    await db.execute('''CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, store_id TEXT, plu_code TEXT, barcode TEXT, internal_barcode TEXT,
      name TEXT NOT NULL, base_price REAL NOT NULL, mrp REAL,
      hsn_code TEXT, gst_rate REAL DEFAULT 0, unit_type TEXT DEFAULT 'piece',
      is_loose INTEGER DEFAULT 0, is_price_locked INTEGER DEFAULT 1,
      stock_qty REAL DEFAULT 0, low_stock_at REAL DEFAULT 0,
      category TEXT, updated_at TEXT
    )''');
    await db.execute('''CREATE TABLE IF NOT EXISTS volume_discount_rules (
      id TEXT PRIMARY KEY, store_id TEXT, product_id TEXT,
      min_qty REAL, effective_price REAL, label TEXT,
      valid_from TEXT, valid_to TEXT
    )''');
    await db.execute('''CREATE TABLE IF NOT EXISTS pending_sync_queue (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, sync_status TEXT DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0, last_error TEXT,
      created_offline_at TEXT, synced_at TEXT
    )''');
    await db.execute('''CREATE TABLE IF NOT EXISTS supervisor_hashes (
      user_id TEXT PRIMARY KEY, card_hash TEXT, store_id TEXT
    )''');
    await db.execute('''CREATE TABLE IF NOT EXISTS shift_cache (
      shift_id TEXT PRIMARY KEY, branch_id TEXT, cashier_id TEXT,
      opening_cash REAL, total_sales REAL DEFAULT 0, status TEXT
    )''');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_products_plu ON products(plu_code)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_sync_status ON pending_sync_queue(sync_status)');
  }

  static Future<void> _onUpgrade(Database db, int oldV, int newV) async {
    if (oldV < 3) {
      await db.execute('ALTER TABLE products ADD COLUMN IF NOT EXISTS internal_barcode TEXT');
    }
  }

  static Future<void> upsertProducts(List<Map<String,dynamic>> products) async {
    final db = await instance;
    final batch = db.batch();
    for (final p in products) {
      batch.insert('products', {
        'id':p['id'],'store_id':p['store_id'],'plu_code':p['plu_code'],'barcode':p['barcode'],
        'internal_barcode':p['internal_barcode'],'name':p['name'],
        'base_price':double.parse(p['base_price'].toString()),'mrp':p['mrp'],
        'hsn_code':p['hsn_code'],'gst_rate':double.parse((p['gst_rate']??0).toString()),
        'unit_type':p['unit_type']??'piece','is_loose':p['is_loose']==true?1:0,
        'is_price_locked':p['is_price_locked']!=false?1:0,
        'stock_qty':double.parse((p['stock_qty']??0).toString()),
        'low_stock_at':double.parse((p['low_stock_at']??0).toString()),
        'category':p['category'],'updated_at':p['updated_at'],
      }, conflictAlgorithm:ConflictAlgorithm.replace);
    }
    await batch.commit(noResult:true);
  }

  static Future<void> upsertVolumeRules(List<Map<String,dynamic>> rules) async {
    final db = await instance;
    await db.delete('volume_discount_rules');
    final batch = db.batch();
    for (final r in rules) {
      batch.insert('volume_discount_rules', r, conflictAlgorithm:ConflictAlgorithm.replace);
    }
    await batch.commit(noResult:true);
  }

  static Future<Map<String,dynamic>?> lookupByPLU(String pluCode, String storeId) async {
    final db = await instance;
    final r  = await db.query('products', where:'plu_code=? AND store_id=?', whereArgs:[pluCode,storeId], limit:1);
    return r.isEmpty ? null : r.first;
  }

  static Future<Map<String,dynamic>?> lookupByBarcode(String barcode, String storeId) async {
    final db = await instance;
    final r  = await db.query('products',
        where:'(barcode=? OR internal_barcode=?) AND store_id=?', whereArgs:[barcode,barcode,storeId], limit:1);
    return r.isEmpty ? null : r.first;
  }

  static Future<List<Map<String,dynamic>>> getVolumeRules(String productId) async {
    final db = await instance;
    return db.query('volume_discount_rules', where:'product_id=?', whereArgs:[productId],
        orderBy:'min_qty DESC');
  }
}
