const Hapi = require('@hapi/hapi');
const Cookie = require('@hapi/cookie');
const Inert = require('@hapi/inert');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');
const {
  authenticate,isCentral,canManageMaster,canManageEmployees,branchScope,log
} = require('./auth');
require('dotenv').config();

const server = Hapi.server({
  port: Number(process.env.PORT || 3000),
  host: 'localhost',
  routes: { cors: { origin: ['*'], credentials: true } }
});

const ok = (h, data={}) => h.response({success:true,...data});
const fail = (h, code, message) => h.response({success:false,message}).code(code);
const me = r => r.auth.credentials;

function requireLogin(r,h) {
  if (!r.auth.isAuthenticated || !me(r)) return fail(h,401,'Silakan login terlebih dahulu.');
  return null;
}

function roleHome(role) {
  return ({
    bos:'/bos/index.html',
    admin_pusat:'/admin-pusat/index.html',
    admin_cabang:'/admin-cabang/index.html',
    pegawai:'/pegawai/index.html'
  })[role] || '/login.html';
}

function allowedBranch(user, branchId) {
  if (isCentral(user)) return true;
  return Number(user.branch_id) === Number(branchId);
}

async function ensureSchema(){
  const q = async (sql) => { try { await db.query(sql); } catch(e) { console.warn('Schema migration:', e.message); } };
  await q("ALTER TABLE products ADD COLUMN favorite TINYINT(1) NOT NULL DEFAULT 0");
  await q("ALTER TABLE products ADD COLUMN online_stock INT NOT NULL DEFAULT 0");
  await q("ALTER TABLE products ADD COLUMN barcode VARCHAR(80) DEFAULT ''");
  await q("ALTER TABLE customers ADD COLUMN email VARCHAR(120) DEFAULT ''");
  await q("ALTER TABLE customers ADD COLUMN ktp VARCHAR(40) DEFAULT ''");
  await q("ALTER TABLE customers ADD COLUMN gender VARCHAR(20) DEFAULT ''");
  await q("ALTER TABLE customers ADD COLUMN birthdate DATE NULL");
  await q("ALTER TABLE customers ADD COLUMN notes TEXT NULL");
  await q("ALTER TABLE customers ADD COLUMN photo VARCHAR(255) DEFAULT ''");
  await q("ALTER TABLE customers ADD COLUMN branch_id INT UNSIGNED NULL");
  await q("ALTER TABLE users ADD COLUMN photo LONGTEXT NULL");
  await q("ALTER TABLE users ADD COLUMN archived_at DATETIME NULL");
  await q("ALTER TABLE users MODIFY photo LONGTEXT NULL");
  await q("ALTER TABLE transactions MODIFY payment_method ENUM('tunai','transfer','qris','kasbon') NOT NULL DEFAULT 'tunai'");
  await q("ALTER TABLE transactions ADD COLUMN payment_method ENUM('tunai','transfer','qris','kasbon') NOT NULL DEFAULT 'tunai' AFTER customer_id");
  await q("ALTER TABLE transactions MODIFY payment_method ENUM('tunai','transfer','qris','kasbon') NOT NULL DEFAULT 'tunai'");
  await q("ALTER TABLE transactions ADD COLUMN description VARCHAR(255) DEFAULT '' AFTER payment_method");
  await q("ALTER TABLE transactions ADD COLUMN due_date DATE NULL AFTER description");
  await q(`CREATE TABLE IF NOT EXISTS stock_histories (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    branch_id INT UNSIGNED NOT NULL, product_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NULL,
    type ENUM('in','out','adjust') NOT NULL, quantity INT NOT NULL DEFAULT 0,
    before_stock INT NOT NULL DEFAULT 0, after_stock INT NOT NULL DEFAULT 0,
    note VARCHAR(255) DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX(branch_id), INDEX(product_id), INDEX(created_at)
  ) ENGINE=InnoDB`);
  await q(`CREATE TABLE IF NOT EXISTS kasbon_payments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    transaction_id BIGINT UNSIGNED NOT NULL, amount DECIMAL(15,2) NOT NULL,
    user_id INT UNSIGNED NULL, note VARCHAR(255) DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX(transaction_id)
  ) ENGINE=InnoDB`);
  await q(`CREATE TABLE IF NOT EXISTS categories (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE,
    status ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
}

async function init() {
  await server.register([Cookie,Inert]);
  await ensureSchema();

  server.auth.strategy('session','cookie',{
    cookie:{
      name:'facethethic_kasir_session',
      password:process.env.SESSION_SECRET || 'facethethic-kasir-portal-secret-2026-change-this',
      isSecure:false,isHttpOnly:true,path:'/'
    },
    redirectTo:false,
    validate: async (request, session) => {
    if (!session || !session.id) {
        return {
            isValid: false
        };
    }

    try {
        const [rows] = await db.query(`
            SELECT
                u.id,
                u.username,
                u.full_name,
                u.role,
                u.branch_id,
                u.photo,
                u.status,
                b.name AS branch_name
            FROM users u
            LEFT JOIN branches b ON b.id = u.branch_id
            WHERE u.id = ?
            LIMIT 1
        `, [session.id]);

        const u = rows[0];

        if (!u || u.status !== 'aktif') {
            return {
                isValid: false
            };
        }

        return {
            isValid: true,
            credentials: u
        };

    } catch (error) {
        console.error('SESSION VALIDATE ERROR:', error);

        return {
            isValid: false
        };
    }
}
  });
  server.auth.default('session');

  server.route({
    method:'GET',path:'/',
    options:{auth:false},
    handler:(_,h)=>h.file(path.join(__dirname,'../public/login.html'))
  });

  server.route({
    method:'POST',path:'/api/login',
    options:{auth:false},
    handler:async(r,h)=>{
      try{
        const username=String(r.payload?.username||'').trim();
        const password=String(r.payload?.password||'');
        const u=await authenticate(username,password);
        if(!u) return fail(h,401,'Username atau password salah.');
        r.cookieAuth.set({id:u.id});
        await log(u.id,'LOGIN','Login ke sistem');
        return ok(h,{user:u,redirect:roleHome(u.role)});
      }catch(e){
        console.error('LOGIN ERROR:',e);
        return fail(h,500,'Gagal memproses login. Periksa koneksi database.');
      }
    }
  });

  server.route({method:'POST',path:'/api/logout',handler:async(r,h)=>{
    const u=me(r);
    if(u) await log(u.id,'LOGOUT','Logout dari sistem');
    r.cookieAuth.clear();
    return ok(h);
  }});

  server.route({method:'GET',path:'/api/me',handler:(r,h)=>{
    const a=requireLogin(r,h); if(a)return a;
    return ok(h,{user:me(r)});
  }});

  server.route({method:'PUT',path:'/api/me',handler:async(r,h)=>{
    const a=requireLogin(r,h); if(a)return a;
    const u=me(r);
    const p=r.payload||{};
    const fullName=String(p.full_name??u.full_name).trim();
    const username=String(p.username??u.username).trim();
    if(!fullName||!username) return fail(h,400,'Nama dan username wajib diisi.');
    const photo = p.photo===undefined ? (u.photo||'') : String(p.photo||'');
    if(photo && photo.length>1500000) return fail(h,400,'Ukuran foto terlalu besar. Gunakan foto maksimal sekitar 1 MB.');
    try{
      await db.query('UPDATE users SET username=?,full_name=?,photo=? WHERE id=?',[username,fullName,photo,u.id]);
      const [rows]=await db.query(`SELECT u.id,u.username,u.full_name,u.role,u.branch_id,u.photo,u.status,u.archived_at,b.name branch_name FROM users u LEFT JOIN branches b ON b.id=u.branch_id WHERE u.id=? LIMIT 1`,[u.id]);
      const updated=rows[0];
      r.cookieAuth.set({id:u.id});
      await log(u.id,'UPDATE_PROFILE','Memperbarui profil akun sendiri');
      return ok(h,{user:updated});
    }catch(e){
      if(e.code==='ER_DUP_ENTRY') return fail(h,409,'Username sudah digunakan.');
      throw e;
    }
  }});

  server.route({method:'GET',path:'/api/dashboard',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const u=me(r); const branchId=branchScope(u,r.query.branch_id);
    const where=branchId?'WHERE t.branch_id=?':'';
    const args=branchId?[branchId]:[];
    const [[sales]]=await db.query(`
      SELECT COALESCE(SUM(total),0) sales,COUNT(*) transactions
      FROM transactions t ${where}${where?' AND':' WHERE'} t.status='selesai' AND DATE(t.created_at)=CURDATE()
    `,args);
    const stockWhere=branchId?'WHERE bs.branch_id=?':'';
    const [[stock]]=await db.query(`
      SELECT COALESCE(SUM(bs.stock),0) stock,
             SUM(CASE WHEN bs.stock<=p.min_stock THEN 1 ELSE 0 END) low
      FROM branch_stocks bs JOIN products p ON p.id=bs.product_id ${stockWhere}
    `,branchId?[branchId]:[]);
    const [[products]]=await db.query("SELECT COUNT(*) count FROM products WHERE status='aktif'");
    const [[branches]]=await db.query("SELECT COUNT(*) count FROM branches WHERE status='aktif'");
    const employeeWhere=branchId?'WHERE branch_id=? AND status=\'aktif\'':'WHERE status=\'aktif\''; const [[employees]]=await db.query(`SELECT COUNT(*) count FROM users ${employeeWhere}`,branchId?[branchId]:[]);
    const custWhere=branchId?'WHERE branch_id=? OR branch_id IS NULL':''; const [[customers]]=await db.query(`SELECT COUNT(*) count FROM customers ${custWhere}`,branchId?[branchId]:[]);
    const txWhere=branchId?'WHERE branch_id=? AND status=\'selesai\' AND payment_method=\'kasbon\'':'WHERE status=\'selesai\' AND payment_method=\'kasbon\''; const [[kb]]=await db.query(`SELECT COALESCE(SUM(t.total-t.paid-COALESCE((SELECT SUM(kp.amount) FROM kasbon_payments kp WHERE kp.transaction_id=t.id),0)),0) amount FROM transactions t ${txWhere}`,branchId?[branchId]:[]);
    const [recent]=await db.query(`
      SELECT t.id,t.invoice_no,t.total,t.payment_method,t.created_at,b.name branch_name,u.full_name
      FROM transactions t JOIN branches b ON b.id=t.branch_id JOIN users u ON u.id=t.user_id
      ${where} ORDER BY t.id DESC LIMIT 8
    `,args);
    const [dailySales]=await db.query(`SELECT DATE(t.created_at) day,COALESCE(SUM(t.total),0) sales,COUNT(*) transactions FROM transactions t ${where}${where?' AND':' WHERE'} t.status='selesai' AND DATE(t.created_at)>=DATE_SUB(CURDATE(),INTERVAL 6 DAY) GROUP BY DATE(t.created_at) ORDER BY day` ,args);
    const [paymentSummary]=await db.query(`SELECT t.payment_method,COUNT(*) transactions,COALESCE(SUM(t.total),0) sales FROM transactions t ${where}${where?' AND':' WHERE'} t.status='selesai' AND DATE(t.created_at)=CURDATE() GROUP BY t.payment_method ORDER BY sales DESC`,args);
    const [branchSummary]=isCentral(u)?await db.query(`
      SELECT b.id,b.code,b.name,b.status,
        COALESCE((SELECT COUNT(*) FROM transactions tx WHERE tx.branch_id=b.id AND tx.status='selesai' AND DATE(tx.created_at)=CURDATE()),0) transactions,
        COALESCE((SELECT SUM(tx.total) FROM transactions tx WHERE tx.branch_id=b.id AND tx.status='selesai' AND DATE(tx.created_at)=CURDATE()),0) sales,
        COALESCE((SELECT COUNT(*) FROM branch_stocks bs JOIN products pp ON pp.id=bs.product_id WHERE bs.branch_id=b.id AND bs.stock<=pp.min_stock),0) low_stock
      FROM branches b WHERE b.status='aktif' ORDER BY b.id
    `):[[]];
    return ok(h,{summary:{
      sales:Number(sales.sales),transactions:Number(sales.transactions),
      stock:Number(stock.stock||0),lowStock:Number(stock.low||0),
      products:Number(products.count),branches:Number(branches.count),employees:Number(employees.count||0),customers:Number(customers.count||0),kasbon:Number(kb.amount||0)
    },recent,branchSummary,dailySales,paymentSummary});
  }});

  server.route({method:'GET',path:'/api/branches',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    if(!isCentral(me(r))) return fail(h,403,'Akses pusat diperlukan.');
    const [rows]=await db.query('SELECT * FROM branches ORDER BY id');
    return ok(h,{branches:rows});
  }});
  server.route({method:'POST',path:'/api/branches',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    return fail(h,403,'Penambahan cabang tidak tersedia.');
  }});
  server.route({method:'PUT',path:'/api/branches/{id}',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    if(me(r).role!=='bos') return fail(h,403,'Hanya Bos yang dapat mengelola cabang.');
    const p=r.payload||{};
    await db.query(
      'UPDATE branches SET code=?,name=?,address=?,phone=?,status=? WHERE id=?',
      [p.code,p.name,p.address||'',p.phone||'',p.status||'aktif',r.params.id]
    );
    return ok(h);
  }});

  server.route({method:'GET',path:'/api/branches/{id}',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a; const u=me(r); if(!isCentral(u))return fail(h,403,'Akses pusat diperlukan.');
    const [b]=await db.query('SELECT * FROM branches WHERE id=?',[r.params.id]); if(!b[0])return fail(h,404,'Cabang tidak ditemukan.');
    const [[sales]]=await db.query('SELECT COALESCE(SUM(total),0) sales,COUNT(*) transactions FROM transactions WHERE branch_id=? AND status=\'selesai\'',[r.params.id]);
    const [[stock]]=await db.query('SELECT COALESCE(SUM(stock),0) stock,SUM(CASE WHEN bs.stock<=p.min_stock THEN 1 ELSE 0 END) low FROM branch_stocks bs JOIN products p ON p.id=bs.product_id WHERE bs.branch_id=?',[r.params.id]);
    const [[staff]]=await db.query('SELECT COUNT(*) count FROM users WHERE branch_id=? AND status=\'aktif\'',[r.params.id]); return ok(h,{branch:b[0],stats:{...sales,...stock,staff:Number(staff.count||0)}});
  }});

  server.route({method:'GET',path:'/api/brands',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const [rows]=await db.query('SELECT * FROM brands ORDER BY name');
    return ok(h,{brands:rows});
  }});
  server.route({method:'POST',path:'/api/brands',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    if(!canManageMaster(me(r)))return fail(h,403,'Akses ditolak.');
    const [x]=await db.query('INSERT INTO brands(name) VALUES(?)',[r.payload?.name]);
    return ok(h,{id:x.insertId});
  }});
  server.route({method:'PUT',path:'/api/brands/{id}',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;if(!canManageMaster(me(r)))return fail(h,403,'Akses ditolak.');
    const name=String(r.payload?.name||'').trim(); if(!name)return fail(h,400,'Nama merek wajib diisi.'); await db.query('UPDATE brands SET name=?,status=? WHERE id=?',[name,r.payload?.status||'aktif',r.params.id]); return ok(h);
  }});

  server.route({method:'GET',path:'/api/categories',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a; const [rows]=await db.query('SELECT * FROM categories ORDER BY name'); return ok(h,{categories:rows});
  }});
  server.route({method:'POST',path:'/api/categories',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a; if(!canManageMaster(me(r)))return fail(h,403,'Akses ditolak.');
    const name=String(r.payload?.name||'').trim(); if(!name)return fail(h,400,'Nama kategori wajib diisi.'); const [x]=await db.query('INSERT INTO categories(name) VALUES(?)',[name]); return ok(h,{id:x.insertId});
  }});
  server.route({method:'PUT',path:'/api/categories/{id}',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;if(!canManageMaster(me(r)))return fail(h,403,'Akses ditolak.');
    const name=String(r.payload?.name||'').trim(); if(!name)return fail(h,400,'Nama kategori wajib diisi.'); await db.query('UPDATE categories SET name=?,status=? WHERE id=?',[name,r.payload?.status||'aktif',r.params.id]); return ok(h);
  }});

  server.route({method:'GET',path:'/api/products',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const u=me(r), branchId=branchScope(u,r.query.branch_id);
    let sql=`SELECT p.*,b.name brand_name,bs.stock,br.name branch_name
             FROM products p LEFT JOIN brands b ON b.id=p.brand_id
             LEFT JOIN branch_stocks bs ON bs.product_id=p.id
             LEFT JOIN branches br ON br.id=bs.branch_id`;
    const args=[];
    if(branchId){sql+=' WHERE bs.branch_id=?';args.push(branchId);}
    sql+=' ORDER BY p.id DESC';
    const [rows]=await db.query(sql,args);
    return ok(h,{products:rows});
  }});
  server.route({method:'POST',path:'/api/products',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    if(!canManageMaster(me(r)))return fail(h,403,'Hanya Bos/Admin Pusat yang dapat mengelola produk.');
    const p=r.payload||{};
    if(!p.sku||!p.name)return fail(h,400,'SKU dan nama produk wajib diisi.');
    const [x]=await db.query(`
      INSERT INTO products(sku,name,barcode,brand_id,category,unit,purchase_price,selling_price,min_stock,online_stock,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `,[p.sku,p.name,p.barcode||'',p.brand_id||null,p.category||'',p.unit||'pcs',
       Number(p.purchase_price||0),Number(p.selling_price||0),Number(p.min_stock||100),Number(p.online_stock||0),p.status||'aktif']);
    const [branches]=await db.query("SELECT id FROM branches WHERE status='aktif'");
    for(const b of branches)
      await db.query('INSERT IGNORE INTO branch_stocks(branch_id,product_id,stock) VALUES(?,?,0)',[b.id,x.insertId]);
    await log(me(r).id,'CREATE_PRODUCT',`Menambah produk ${p.name}`);
    return ok(h,{id:x.insertId});
  }});
  server.route({method:'PUT',path:'/api/products/{id}',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    if(!canManageMaster(me(r)))return fail(h,403,'Akses ditolak.');
    const p=r.payload||{};
    await db.query(`
      UPDATE products SET sku=?,name=?,barcode=?,brand_id=?,category=?,unit=?,purchase_price=?,selling_price=?,min_stock=?,online_stock=?,status=?
      WHERE id=?
    `,[p.sku,p.name,p.barcode||'',p.brand_id||null,p.category||'',p.unit||'pcs',
       Number(p.purchase_price||0),Number(p.selling_price||0),Number(p.min_stock||100),Number(p.online_stock||0),p.status||'aktif',r.params.id]);
    return ok(h);
  }});

  server.route({method:'PUT',path:'/api/products/{id}/favorite',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a; if(!canManageMaster(me(r)))return fail(h,403,'Akses ditolak.');
    await db.query('UPDATE products SET favorite=? WHERE id=?',[r.payload?.favorite?1:0,r.params.id]); return ok(h);
  }});
  server.route({method:'DELETE',path:'/api/products/{id}',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;if(!canManageMaster(me(r)))return fail(h,403,'Akses ditolak.');
    await db.query("UPDATE products SET status='nonaktif' WHERE id=?",[r.params.id]); await log(me(r).id,'DEACTIVATE_PRODUCT',`Menonaktifkan produk ${r.params.id}`); return ok(h);
  }});

  server.route({method:'GET',path:'/api/stock',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const u=me(r), branchId=branchScope(u,r.query.branch_id);
    let sql=`SELECT bs.*,p.sku,p.name,p.unit,p.selling_price,p.min_stock,br.name branch_name
             FROM branch_stocks bs JOIN products p ON p.id=bs.product_id
             JOIN branches br ON br.id=bs.branch_id`;
    const args=[];
    if(branchId){sql+=' WHERE bs.branch_id=?';args.push(branchId);}
    sql+=' ORDER BY bs.stock ASC,p.name ASC';
    const [rows]=await db.query(sql,args);
    return ok(h,{stock:rows});
  }});
  server.route({method:'POST',path:'/api/stock/adjust',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const u=me(r);
    if(!['bos','admin_pusat','admin_cabang'].includes(u.role))return fail(h,403,'Akses pengaturan stok ditolak.');
    const raw=r.payload||{};
    const branch_id=isCentral(u)?Number(raw.branch_id):Number(u.branch_id);
    const {product_id,quantity,type}=raw;
    const qty=Number(quantity);
    const note=String(raw.note||'').trim();
    if(!branch_id||!product_id||qty<0||!['in','out','adjust'].includes(type))
      return fail(h,400,'Data stok tidak valid.');
    if(!note) return fail(h,400,'Keterangan wajib diisi untuk keperluan audit.');
    if(note.length>255) return fail(h,400,'Keterangan maksimal 255 karakter.');
    const conn=await db.getConnection();
    try{
      await conn.beginTransaction();
      const [check]=await conn.query(
        'SELECT id,stock FROM branch_stocks WHERE branch_id=? AND product_id=? FOR UPDATE',
        [branch_id,product_id]
      );
      if(!check[0]){
        if(type==='out'){await conn.rollback();return fail(h,400,'Stok produk belum tersedia di cabang tersebut.');}
        await conn.query('INSERT INTO branch_stocks(branch_id,product_id,stock) VALUES(?,?,0)',[branch_id,product_id]);
      }
      const beforeStock=check[0]?Number(check[0].stock):0;
      const delta=type==='in'?qty:(type==='out'?-qty:qty-beforeStock);
      const [res]=await conn.query(
        'UPDATE branch_stocks SET stock=stock+? WHERE branch_id=? AND product_id=? AND stock+?>=0',
        [delta,branch_id,product_id,delta]
      );
      if(res.affectedRows!==1)throw new Error('Stok tidak mencukupi.');
      const [afterRows]=await conn.query('SELECT stock FROM branch_stocks WHERE branch_id=? AND product_id=?',[branch_id,product_id]);
      const before=check[0]?Number(check[0].stock):0; const after=Number(afterRows[0]?.stock||0);
      await conn.query('INSERT INTO stock_histories(branch_id,product_id,user_id,type,quantity,before_stock,after_stock,note) VALUES(?,?,?,?,?,?,?,?)',[branch_id,product_id,u.id,type,type==='adjust'?Math.abs(after-before):qty,before,after,note]);
      await conn.commit();
      await log(u.id,'ADJUST_STOCK',`${type==='in'?'Menambah':'Mengurangi'} ${qty} stok`);
      return ok(h);
    }catch(e){
      await conn.rollback().catch(()=>{});
      return fail(h,400,e.message);
    }finally{conn.release();}
  }});

  server.route({method:'GET',path:'/api/stock/history',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a; const u=me(r); let sql=`SELECT sh.*,p.name product_name,p.sku,b.name branch_name,COALESCE(usr.full_name,'-') user_name FROM stock_histories sh JOIN products p ON p.id=sh.product_id JOIN branches b ON b.id=sh.branch_id LEFT JOIN users usr ON usr.id=sh.user_id`; const args=[];
    if(isCentral(u)){ if(r.query.branch_id){sql+=' WHERE sh.branch_id=?';args.push(r.query.branch_id);} } else {sql+=' WHERE sh.branch_id=?';args.push(u.branch_id);}
    sql+=' ORDER BY sh.id DESC LIMIT 300'; const [rows]=await db.query(sql,args); return ok(h,{history:rows});
  }});

  server.route({method:'GET',path:'/api/customers',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const u=me(r); let sql='SELECT c.*,b.name branch_name,(SELECT COUNT(*) FROM transactions t WHERE t.customer_id=c.id AND t.status=\'selesai\') transaction_count FROM customers c LEFT JOIN branches b ON b.id=c.branch_id'; const args=[];
    if(!isCentral(u)){sql+=' WHERE (c.branch_id=? OR c.branch_id IS NULL)';args.push(u.branch_id);}
    sql+=' ORDER BY c.id DESC'; const [rows]=await db.query(sql,args); return ok(h,{customers:rows});
  }});
  server.route({method:'POST',path:'/api/customers',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a; const u=me(r),p=r.payload||{};
    if(!p.name)return fail(h,400,'Nama pelanggan wajib diisi.');
    const branchId=isCentral(u)?(p.branch_id?Number(p.branch_id):null):Number(u.branch_id);
    const [x]=await db.query(`INSERT INTO customers(name,phone,email,ktp,gender,birthdate,address,notes,photo,branch_id) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [p.name,p.phone||'',p.email||'',p.ktp||'',p.gender||'',p.birthdate||null,p.address||'',p.notes||'',p.photo||'',branchId]);
    return ok(h,{id:x.insertId});
  }});
  server.route({method:'PUT',path:'/api/customers/{id}',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a; const u=me(r),p=r.payload||{};
    const [rows]=await db.query('SELECT * FROM customers WHERE id=?',[r.params.id]); if(!rows[0])return fail(h,404,'Pelanggan tidak ditemukan.');
    if(!isCentral(u)&&rows[0].branch_id && Number(rows[0].branch_id)!==Number(u.branch_id))return fail(h,403,'Pelanggan bukan milik cabang Anda.');
    await db.query(`UPDATE customers SET name=?,phone=?,email=?,ktp=?,gender=?,birthdate=?,address=?,notes=?,photo=? WHERE id=?`,
      [p.name,p.phone||'',p.email||'',p.ktp||'',p.gender||'',p.birthdate||null,p.address||'',p.notes||'',p.photo||'',r.params.id]); return ok(h);
  }});
  server.route({method:'GET',path:'/api/customers/{id}',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a; const u=me(r); const [rows]=await db.query('SELECT c.*,b.name branch_name FROM customers c LEFT JOIN branches b ON b.id=c.branch_id WHERE c.id=?',[r.params.id]);
    if(!rows[0])return fail(h,404,'Pelanggan tidak ditemukan.'); if(!isCentral(u)&&rows[0].branch_id && Number(rows[0].branch_id)!==Number(u.branch_id))return fail(h,403,'Akses ditolak.');
    const [history]=await db.query(`SELECT t.id,t.invoice_no,t.total,t.payment_method,t.created_at FROM transactions t WHERE t.customer_id=? ORDER BY t.id DESC LIMIT 100`,[r.params.id]);
    return ok(h,{customer:rows[0],history});
  }});

  server.route({method:'DELETE',path:'/api/customers/{id}',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a; const u=me(r);
    const [rows]=await db.query('SELECT * FROM customers WHERE id=?',[r.params.id]); if(!rows[0])return fail(h,404,'Pelanggan tidak ditemukan.');
    if(!isCentral(u) && rows[0].branch_id && Number(rows[0].branch_id)!==Number(u.branch_id)) return fail(h,403,'Akses ditolak.');
    const [[used]]=await db.query('SELECT COUNT(*) count FROM transactions WHERE customer_id=?',[r.params.id]);
    if(Number(used.count)>0) return fail(h,400,'Pelanggan memiliki riwayat transaksi dan tidak dapat dihapus.');
    await db.query('DELETE FROM customers WHERE id=?',[r.params.id]); await log(u.id,'DELETE_CUSTOMER',`Menghapus pelanggan ${rows[0].name}`); return ok(h);
  }});

  server.route({method:'GET',path:'/api/users',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const u=me(r);
    if(!['bos','admin_cabang'].includes(u.role))return fail(h,403,'Akses pegawai ditolak.');
    let sql=`SELECT u.id,u.username,u.full_name,u.role,u.branch_id,u.photo,u.status,u.archived_at,b.name branch_name
             FROM users u LEFT JOIN branches b ON b.id=u.branch_id`;
    const args=[];
    if(!isCentral(u)){sql+=' WHERE u.branch_id=?';args.push(u.branch_id);}
    sql+=' ORDER BY u.id DESC';
    const [rows]=await db.query(sql,args);
    return ok(h,{users:rows});
  }});
  server.route({method:'POST',path:'/api/users',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const actor=me(r);
    if(actor.role!=='bos')return fail(h,403,'Hanya Bos yang dapat membuat akun pegawai.');
    const p=r.payload||{};
    if(!p.username||!p.password||!p.full_name||!p.role)return fail(h,400,'Data akun belum lengkap.');
    const photo=String(p.photo||'');
    if(photo.length>1500000)return fail(h,400,'Ukuran foto terlalu besar.');
    if(!['admin_pusat','admin_cabang','pegawai'].includes(p.role))return fail(h,400,'Role akun yang dapat dibuat: Admin Pusat, Admin Cabang, atau Pegawai.');
    if(!isCentral(actor) && p.role!=='pegawai' && p.role!=='admin_cabang')
      return fail(h,403,'Admin Cabang hanya dapat membuat akun cabangnya.');
    const branchId=isCentral(actor)?(p.branch_id||null):actor.branch_id;
    if(['admin_cabang','pegawai'].includes(p.role) && !branchId)return fail(h,400,'Cabang wajib dipilih.');
    const hash=await bcrypt.hash(p.password,10);
    const [x]=await db.query(
      'INSERT INTO users(username,password_hash,full_name,role,branch_id,photo,status) VALUES(?,?,?,?,?,?,?)',
      [p.username,hash,p.full_name,p.role,branchId,photo,p.status||'aktif']
    );
    await log(actor.id,'CREATE_USER',`Membuat akun ${p.username}`);
    return ok(h,{id:x.insertId});
  }});
  server.route({method:'PUT',path:'/api/users/{id}',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const actor=me(r);if(actor.role!=='bos')return fail(h,403,'Hanya Bos yang dapat mengubah akun pegawai.');
    const p=r.payload||{};
    const [targetRows]=await db.query('SELECT * FROM users WHERE id=?',[r.params.id]);
    const target=targetRows[0];
    if(!target)return fail(h,404,'Akun tidak ditemukan.');
    if(!isCentral(actor)&&target.branch_id!==actor.branch_id)return fail(h,403,'Akun bukan milik cabang Anda.');
    const branchId=isCentral(actor)?(p.branch_id??target.branch_id):actor.branch_id;
    const photo=p.photo===undefined?(target.photo||''):String(p.photo||'');
    if(photo.length>1500000)return fail(h,400,'Ukuran foto terlalu besar.');
    if(p.password){
      const hash=await bcrypt.hash(p.password,10);
      await db.query(
        'UPDATE users SET username=?,full_name=?,role=?,branch_id=?,photo=?,status=?,password_hash=? WHERE id=?',
        [p.username,p.full_name,p.role,branchId,photo,p.status||'aktif',hash,r.params.id]
      );
    }else{
      await db.query(
        'UPDATE users SET username=?,full_name=?,role=?,branch_id=?,photo=?,status=? WHERE id=?',
        [p.username,p.full_name,p.role,branchId,photo,p.status||'aktif',r.params.id]
      );
    }
    return ok(h);
  }});

  server.route({method:'POST',path:'/api/users/{id}/archive',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const actor=me(r);
    if(actor.role!=='bos')return fail(h,403,'Hanya Bos yang dapat mengarsipkan akun.');
    const id=Number(r.params.id);
    if(id===Number(actor.id))return fail(h,400,'Akun Bos yang sedang digunakan tidak dapat diarsipkan.');
    const [rows]=await db.query('SELECT id,username,role,archived_at FROM users WHERE id=?',[id]);
    const target=rows[0];
    if(!target)return fail(h,404,'Akun tidak ditemukan.');
    if(target.role==='bos')return fail(h,403,'Akun Bos tidak dapat diarsipkan dari menu ini.');
    const archived=Boolean(r.payload?.archived);
    await db.query('UPDATE users SET archived_at=? WHERE id=?',[archived?new Date():null,id]);
    await log(actor.id,archived?'ARCHIVE_USER':'RESTORE_USER',`${archived?'Mengarsipkan':'Memulihkan'} akun ${target.username}`);
    return ok(h);
  }});

  server.route({method:'DELETE',path:'/api/users/{id}',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const actor=me(r);
    if(actor.role!=='bos')return fail(h,403,'Hanya Bos yang dapat menghapus akun.');
    const id=Number(r.params.id);
    if(id===Number(actor.id))return fail(h,400,'Akun yang sedang digunakan tidak dapat dihapus.');
    const [rows]=await db.query('SELECT id,username,role FROM users WHERE id=?',[id]);
    const target=rows[0];
    if(!target)return fail(h,404,'Akun tidak ditemukan.');
    if(target.role==='bos')return fail(h,403,'Akun Bos tidak dapat dihapus dari menu ini.');
    const [[usage]]=await db.query('SELECT COUNT(*) AS total FROM transactions WHERE user_id=?',[id]);
    if(Number(usage.total)>0)return fail(h,409,'Akun memiliki riwayat transaksi. Arsipkan akun agar riwayat tetap aman.');
    await db.query('DELETE FROM users WHERE id=?',[id]);
    await log(actor.id,'DELETE_USER',`Menghapus akun ${target.username}`);
    return ok(h);
  }});

  server.route({method:'POST',path:'/api/transactions',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const u=me(r), p=r.payload||{};
    const branchId=isCentral(u)?Number(p.branch_id||u.branch_id):Number(u.branch_id);
    const paymentMethod=['tunai','transfer','qris','kasbon'].includes(p.payment_method)?p.payment_method:'tunai';
    if(!branchId)return fail(h,400,'Cabang transaksi wajib dipilih.');
    if(!Array.isArray(p.items)||!p.items.length)return fail(h,400,'Keranjang masih kosong.');
    if(!allowedBranch(u,branchId))return fail(h,403,'Anda tidak dapat bertransaksi di cabang ini.');

    const conn=await db.getConnection();
    try{
      await conn.beginTransaction();
      let subtotal=0;
      const normalized=[];
      for(const item of p.items){
        const qty=Number(item.quantity);
        if(qty<=0)throw new Error('Jumlah produk tidak valid.');
        const [rows]=await conn.query(`
          SELECT p.id,p.selling_price,bs.stock
          FROM products p JOIN branch_stocks bs ON bs.product_id=p.id
          WHERE p.id=? AND bs.branch_id=? AND p.status='aktif' FOR UPDATE
        `,[item.product_id,branchId]);
        const row=rows[0];
        if(!row)throw new Error('Produk tidak tersedia di cabang.');
        if(row.stock<qty)throw new Error(`Stok tidak cukup untuk produk ID ${item.product_id}.`);
        const price=Number(row.selling_price);
        const line=price*qty; subtotal+=line;
        normalized.push({product_id:row.id,quantity:qty,price,subtotal:line});
      }
      const discount=Math.max(0,Number(p.discount||0));
      const tax=Math.max(0,Number(p.tax||0));
      const total=Math.max(0,subtotal-discount+tax);
      const paid=Math.max(0,Number(p.paid||0));
      if(paymentMethod==='kasbon' && !p.customer_id)throw new Error('Pelanggan wajib dipilih untuk transaksi kasbon.');
      if(paymentMethod==='kasbon' && !p.due_date)throw new Error('Jatuh tempo wajib diisi untuk kasbon.');
      if(paymentMethod!=='kasbon' && paid<total)throw new Error('Pembayaran kurang.');
      if(paid>total && paymentMethod!=='tunai')throw new Error('Jumlah dibayar tidak boleh melebihi total untuk metode ini.');
      const change=paymentMethod==='tunai'?Math.max(0,paid-total):0;
      const invoice='INV-'+new Date().toISOString().replace(/\D/g,'').slice(0,14)+'-'+Math.floor(Math.random()*900+100);
      const [tx]=await conn.query(`
        INSERT INTO transactions(invoice_no,user_id,branch_id,customer_id,payment_method,description,due_date,subtotal,discount,tax,total,paid,change_amount)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      `,[invoice,u.id,branchId,p.customer_id||null,paymentMethod,String(p.description||''),p.due_date||null,subtotal,discount,tax,total,paid,change]);
      for(const item of normalized){
        await conn.query(
          'INSERT INTO transaction_items(transaction_id,product_id,quantity,price,subtotal) VALUES(?,?,?,?,?)',
          [tx.insertId,item.product_id,item.quantity,item.price,item.subtotal]
        );
        await conn.query(
          'UPDATE branch_stocks SET stock=stock-? WHERE branch_id=? AND product_id=?',
          [item.quantity,branchId,item.product_id]
        );
      }
      await conn.commit();
      await log(u.id,'CREATE_TRANSACTION',`Transaksi ${invoice}`);
      return ok(h,{id:tx.insertId,invoice_no:invoice,total,paid,change});
    }catch(e){
      await conn.rollback().catch(()=>{});
      return fail(h,400,e.message);
    }finally{conn.release();}
  }});

  server.route({method:'POST',path:'/api/transactions/manual',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const u=me(r),p=r.payload||{};
    const branchId=isCentral(u)?Number(p.branch_id||u.branch_id):Number(u.branch_id);
    const paymentMethod=['tunai','transfer','qris','kasbon'].includes(p.payment_method)?p.payment_method:'tunai';
    const amount=Number(p.amount||0);
    if(!branchId)return fail(h,400,'Cabang transaksi wajib dipilih.');
    if(!allowedBranch(u,branchId))return fail(h,403,'Anda tidak dapat bertransaksi di cabang ini.');
    if(amount<=0)return fail(h,400,'Nominal harus lebih dari 0.');
    if(!String(p.description||'').trim())return fail(h,400,'Deskripsi wajib diisi.');
    const paid=Math.max(0,Number(p.paid||0));
    if(paymentMethod==='kasbon'&&!p.customer_id)return fail(h,400,'Pelanggan wajib dipilih untuk transaksi kasbon.');
    if(paymentMethod==='kasbon'&&!p.due_date)return fail(h,400,'Jatuh tempo wajib diisi untuk kasbon.');
    if(paymentMethod!=='kasbon'&&paid<amount)return fail(h,400,'Pembayaran kurang.');
    if(paymentMethod!=='tunai'&&paymentMethod!=='kasbon'&&paid>amount)return fail(h,400,'Jumlah dibayar tidak boleh melebihi total.');
    const change=paymentMethod==='tunai'?Math.max(0,paid-amount):0;
    const invoice='INV-'+new Date().toISOString().replace(/\D/g,'').slice(0,14)+'-'+Math.floor(Math.random()*900+100);
    const [x]=await db.query(`INSERT INTO transactions(invoice_no,user_id,branch_id,customer_id,payment_method,description,due_date,subtotal,discount,tax,total,paid,change_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,[invoice,u.id,branchId,p.customer_id||null,paymentMethod,String(p.description).trim(),p.due_date||null,amount,0,0,amount,paid,change]);
    await log(u.id,'CREATE_MANUAL_TRANSACTION',`Transaksi manual ${invoice}`);
    return ok(h,{id:x.insertId,invoice_no:invoice,total:amount,paid,change});
  }});

  server.route({method:'GET',path:'/api/transactions',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const u=me(r),branchId=branchScope(u,r.query.branch_id);
    let sql=`SELECT t.*,b.name branch_name,u.full_name cashier,c.name customer_name,c.phone customer_phone
             FROM transactions t JOIN branches b ON b.id=t.branch_id
             JOIN users u ON u.id=t.user_id LEFT JOIN customers c ON c.id=t.customer_id`;
    const args=[];
    if(branchId){sql+=' WHERE t.branch_id=?';args.push(branchId);}
    sql+=' ORDER BY t.id DESC LIMIT 300';
    const [rows]=await db.query(sql,args);
    return ok(h,{transactions:rows});
  }});

  server.route({method:'PUT',path:'/api/transactions/{id}',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const u=me(r);
    if(u.role!=='bos')return fail(h,403,'Hanya Bos yang dapat mengedit transaksi dari Riwayat.');
    const p=r.payload||{};
    const id=Number(r.params.id);
    const conn=await db.getConnection();
    try{
      await conn.beginTransaction();
      const [txRows]=await conn.query('SELECT * FROM transactions WHERE id=? FOR UPDATE',[id]);
      const old=txRows[0];
      if(!old)throw new Error('Transaksi tidak ditemukan.');
      if(old.status==='batal')throw new Error('Transaksi yang sudah dibatalkan tidak dapat diedit.');
      const paymentMethod=['tunai','transfer','qris','kasbon'].includes(p.payment_method)?p.payment_method:old.payment_method;
      const branchId=Number(p.branch_id||old.branch_id);
      const customerId=p.customer_id?Number(p.customer_id):null;
      const description=String(p.description??old.description??'');
      const dueDate=p.due_date||null;
      const discount=Math.max(0,Number(p.discount??old.discount??0));
      const tax=Math.max(0,Number(p.tax??old.tax??0));
      const paid=Math.max(0,Number(p.paid??old.paid??0));
      if(!branchId)throw new Error('Cabang transaksi wajib dipilih.');
      if(paymentMethod==='kasbon' && !customerId)throw new Error('Pelanggan wajib dipilih untuk transaksi kasbon.');
      if(paymentMethod==='kasbon' && !dueDate)throw new Error('Jatuh tempo wajib diisi untuk kasbon.');

      const [oldItems]=await conn.query('SELECT * FROM transaction_items WHERE transaction_id=? FOR UPDATE',[id]);
      // Return the stock consumed by the previous version before validating the new version.
      for(const item of oldItems){
        await conn.query('UPDATE branch_stocks SET stock=stock+? WHERE branch_id=? AND product_id=?',[item.quantity,old.branch_id,item.product_id]);
      }

      const normalized=[];
      let subtotal=0;
      const items=Array.isArray(p.items)?p.items:oldItems.map(x=>({product_id:x.product_id,quantity:x.quantity}));
      for(const item of items){
        const qty=Number(item.quantity);
        if(qty<=0)continue;
        const [rows]=await conn.query(`SELECT p.id,p.selling_price,bs.stock FROM products p JOIN branch_stocks bs ON bs.product_id=p.id WHERE p.id=? AND bs.branch_id=? AND p.status='aktif' FOR UPDATE`,[Number(item.product_id),branchId]);
        const row=rows[0];
        if(!row)throw new Error('Produk tidak tersedia di cabang tujuan.');
        if(Number(row.stock)<qty)throw new Error(`Stok tidak cukup untuk produk ID ${item.product_id}.`);
        const price=Number(row.selling_price); const line=price*qty; subtotal+=line;
        normalized.push({product_id:row.id,quantity:qty,price,subtotal:line});
      }
      const total=Math.max(0,subtotal-discount+tax);
      if(paymentMethod==='kasbon'){
        if(paid>total)throw new Error('Pembayaran kasbon tidak boleh melebihi total.');
      }else{
        if(paid<total)throw new Error('Pembayaran kurang.');
        if(paymentMethod!=='tunai'&&paid>total)throw new Error('Jumlah dibayar tidak boleh melebihi total untuk metode ini.');
      }
      const change=paymentMethod==='tunai'?Math.max(0,paid-total):0;
      await conn.query('DELETE FROM transaction_items WHERE transaction_id=?',[id]);
      // If the branch changed, the old stock was returned to the old branch and new stock is taken from the new branch.
      for(const item of normalized){
        await conn.query('INSERT INTO transaction_items(transaction_id,product_id,quantity,price,subtotal) VALUES(?,?,?,?,?)',[id,item.product_id,item.quantity,item.price,item.subtotal]);
        await conn.query('UPDATE branch_stocks SET stock=stock-? WHERE branch_id=? AND product_id=?',[item.quantity,branchId,item.product_id]);
      }
      await conn.query(`UPDATE transactions SET branch_id=?,customer_id=?,payment_method=?,description=?,due_date=?,subtotal=?,discount=?,tax=?,total=?,paid=?,change_amount=? WHERE id=?`,[branchId,customerId,paymentMethod,description,dueDate,subtotal,discount,tax,total,paid,change,id]);
      // Existing additional kasbon payments are kept only when the edited transaction remains a kasbon and still covers them.
      if(paymentMethod!=='kasbon') await conn.query('DELETE FROM kasbon_payments WHERE transaction_id=?',[id]);
      else {
        const [[kp]]=await conn.query('SELECT COALESCE(SUM(amount),0) paid_after FROM kasbon_payments WHERE transaction_id=?',[id]);
        if(Number(kp.paid_after)+paid>total) throw new Error('Total baru lebih kecil dari pembayaran kasbon yang sudah tercatat.');
      }
      await conn.commit();
      await log(u.id,'EDIT_TRANSACTION',`Mengedit transaksi ${old.invoice_no}`);
      return ok(h,{id,total,paid,change});
    }catch(e){await conn.rollback().catch(()=>{});return fail(h,400,e.message)}finally{conn.release()}
  }});

  server.route({method:'DELETE',path:'/api/transactions/{id}',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const u=me(r);
    if(u.role!=='bos')return fail(h,403,'Hanya Bos yang dapat menghapus transaksi dari Riwayat.');
    const id=Number(r.params.id),conn=await db.getConnection();
    try{
      await conn.beginTransaction();
      const [rows]=await conn.query('SELECT * FROM transactions WHERE id=? FOR UPDATE',[id]); const t=rows[0];
      if(!t)throw new Error('Transaksi tidak ditemukan.');
      const [items]=await conn.query('SELECT * FROM transaction_items WHERE transaction_id=? FOR UPDATE',[id]);
      for(const item of items) await conn.query('UPDATE branch_stocks SET stock=stock+? WHERE branch_id=? AND product_id=?',[item.quantity,t.branch_id,item.product_id]);
      await conn.query('DELETE FROM kasbon_payments WHERE transaction_id=?',[id]);
      await conn.query('DELETE FROM transaction_items WHERE transaction_id=?',[id]);
      await conn.query('DELETE FROM transactions WHERE id=?',[id]);
      await conn.commit();
      await log(u.id,'DELETE_TRANSACTION',`Menghapus transaksi ${t.invoice_no}`);
      return ok(h);
    }catch(e){await conn.rollback().catch(()=>{});return fail(h,400,e.message)}finally{conn.release()}
  }});

  server.route({method:'GET',path:'/api/transactions/{id}',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const [rows]=await db.query(`
      SELECT t.*,b.name branch_name,u.full_name cashier,c.name customer_name,c.phone customer_phone
      FROM transactions t JOIN branches b ON b.id=t.branch_id JOIN users u ON u.id=t.user_id
      LEFT JOIN customers c ON c.id=t.customer_id WHERE t.id=?
    `,[r.params.id]);
    if(!rows[0])return fail(h,404,'Transaksi tidak ditemukan.');
    if(!allowedBranch(me(r),rows[0].branch_id))return fail(h,403,'Akses ditolak.');
    const [items]=await db.query(`
      SELECT ti.*,p.sku,p.name FROM transaction_items ti JOIN products p ON p.id=ti.product_id
      WHERE ti.transaction_id=?
    `,[r.params.id]);
    return ok(h,{transaction:rows[0],items});
  }});

  server.route({method:'GET',path:'/api/kasbon',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a; const u=me(r); let sql=`SELECT t.id,t.invoice_no,t.total,t.paid,t.customer_id,t.branch_id,t.created_at,b.name branch_name,c.name customer_name,u2.full_name cashier,COALESCE((SELECT SUM(kp.amount) FROM kasbon_payments kp WHERE kp.transaction_id=t.id),0) paid_after FROM transactions t JOIN branches b ON b.id=t.branch_id LEFT JOIN customers c ON c.id=t.customer_id JOIN users u2 ON u2.id=t.user_id WHERE t.payment_method='kasbon'`; const args=[];
    if(!isCentral(u)){sql+=' AND t.branch_id=?';args.push(u.branch_id);} if(r.query.status==='lunas')sql+=' HAVING (t.paid+paid_after)>=t.total'; else if(r.query.status==='belum')sql+=' HAVING (t.paid+paid_after)<t.total'; sql+=' ORDER BY t.id DESC LIMIT 300'; const [rows]=await db.query(sql,args); return ok(h,{kasbon:rows});
  }});
  server.route({method:'POST',path:'/api/kasbon/{id}/payment',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a; const u=me(r),amount=Number(r.payload?.amount||0); if(amount<=0)return fail(h,400,'Nominal pembayaran tidak valid.');
    const [rows]=await db.query(`SELECT t.*,COALESCE((SELECT SUM(amount) FROM kasbon_payments WHERE transaction_id=t.id),0) paid_after FROM transactions t WHERE t.id=? AND t.payment_method='kasbon'`,[r.params.id]); const t=rows[0]; if(!t)return fail(h,404,'Kasbon tidak ditemukan.'); if(!allowedBranch(u,t.branch_id))return fail(h,403,'Akses ditolak.'); const remaining=Number(t.total)-Number(t.paid)-Number(t.paid_after); if(amount>remaining)return fail(h,400,'Pembayaran melebihi sisa kasbon.'); await db.query('INSERT INTO kasbon_payments(transaction_id,amount,user_id,note) VALUES(?,?,?,?)',[t.id,amount,u.id,r.payload?.note||'']); await log(u.id,'PAY_KASBON',`Pembayaran kasbon ${t.invoice_no} sebesar ${amount}`); return ok(h,{remaining:remaining-amount});
  }});
  server.route({method:'GET',path:'/api/kasbon/{id}/payments',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a; const u=me(r); const [t]=await db.query('SELECT branch_id FROM transactions WHERE id=?',[r.params.id]); if(!t[0])return fail(h,404,'Kasbon tidak ditemukan.'); if(!allowedBranch(u,t[0].branch_id))return fail(h,403,'Akses ditolak.'); const [rows]=await db.query(`SELECT kp.*,u.full_name FROM kasbon_payments kp LEFT JOIN users u ON u.id=kp.user_id WHERE kp.transaction_id=? ORDER BY kp.id DESC`,[r.params.id]); return ok(h,{payments:rows});
  }});

  server.route({method:'GET',path:'/api/reports',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const u=me(r), branchId=branchScope(u,r.query.branch_id);
    const from=r.query.from||'2000-01-01', to=r.query.to||'2999-12-31';
    const where=branchId?'t.branch_id=? AND':'';
    const args=branchId?[branchId,from,to]:[from,to];
    const [[summary]]=await db.query(`
      SELECT COALESCE(SUM(t.total),0) sales,COUNT(*) transactions,
             COALESCE(SUM(t.discount),0) discount
      FROM transactions t
      WHERE ${where} t.status='selesai' AND DATE(t.created_at) BETWEEN ? AND ?
    `,args);
    const [daily]=await db.query(`
      SELECT DATE(t.created_at) day,COUNT(*) transactions,COALESCE(SUM(t.total),0) sales
      FROM transactions t
      WHERE ${where} t.status='selesai' AND DATE(t.created_at) BETWEEN ? AND ?
      GROUP BY DATE(t.created_at) ORDER BY day DESC
    `,args);
    const stockSql=branchId?`SELECT COALESCE(SUM(bs.stock),0) stock,SUM(CASE WHEN bs.stock<=p.min_stock THEN 1 ELSE 0 END) low FROM branch_stocks bs JOIN products p ON p.id=bs.product_id WHERE bs.branch_id=?`:`SELECT COALESCE(SUM(stock),0) stock,SUM(CASE WHEN bs.stock<=p.min_stock THEN 1 ELSE 0 END) low FROM branch_stocks bs JOIN products p ON p.id=bs.product_id`; const [sr]=await db.query(stockSql,branchId?[branchId]:[]);
    const [topProducts]=await db.query(`SELECT p.name,SUM(ti.quantity) qty,SUM(ti.subtotal) sales FROM transaction_items ti JOIN transactions t ON t.id=ti.transaction_id JOIN products p ON p.id=ti.product_id WHERE ${where} t.status='selesai' AND DATE(t.created_at) BETWEEN ? AND ? GROUP BY p.id ORDER BY sales DESC LIMIT 20`,args);
    const [[kasbon]] = await db.query(`SELECT COALESCE(SUM(t.total-t.paid-COALESCE((SELECT SUM(kp.amount) FROM kasbon_payments kp WHERE kp.transaction_id=t.id),0)),0) outstanding FROM transactions t WHERE ${where} t.payment_method='kasbon' AND t.status='selesai'`,branchId?[branchId]:[]);
    const [[cust]] = await db.query(`SELECT COUNT(*) count FROM customers c ${branchId?'WHERE c.branch_id=? OR c.branch_id IS NULL':''}`,branchId?[branchId]:[]);
    return ok(h,{summary, daily, stock:sr[0]||{stock:0,low:0}, topProducts, kasbon, customers:Number(cust.count||0)});
  }});

  server.route({method:'GET',path:'/api/activity-logs',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    if(!isCentral(me(r)))return fail(h,403,'Akses pusat diperlukan.');
    const [rows]=await db.query(`
      SELECT l.*,u.username,u.full_name FROM activity_logs l
      LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 300
    `);
    return ok(h,{logs:rows});
  }});

  server.route({method:'GET',path:'/api/settings',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    const [rows]=await db.query('SELECT setting_key,setting_value FROM settings ORDER BY setting_key');
    return ok(h,{settings:rows});
  }});
  server.route({method:'PUT',path:'/api/settings',handler:async(r,h)=>{
    const a=requireLogin(r,h);if(a)return a;
    if(!canManageMaster(me(r)))return fail(h,403,'Akses ditolak.');
    const settings=r.payload?.settings||{};
    for(const [key,value] of Object.entries(settings)){
      await db.query(`
        INSERT INTO settings(setting_key,setting_value) VALUES(?,?)
        ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)
      `,[key,String(value)]);
    }
    return ok(h);
  }});

  // Static files are intentionally AFTER API routes.
  server.route({
    method:'GET',path:'/{param*}',
    options:{auth:false},
    handler:(r,h)=>{
      const p=r.params.param||'';
      if(p.startsWith('api/'))return fail(h,404,'API tidak ditemukan.');
      return h.file(path.join(__dirname,'../public',p));
    }
  });

  await server.start();
  console.log(`FACETHEHTIC KASIR PORTAL berjalan di http://localhost:${server.info.port}`);
  console.log('Database:',process.env.DB_NAME||'facethethic_kasir_db');
}

init().catch(err=>{console.error(err);process.exit(1);});
